'use strict';

/**
 * OAuth2 for an installed/desktop app using the loopback redirect flow.
 *
 * Steps:
 *   1. Spin up a temporary localhost HTTP server on a random port.
 *   2. Build the Google consent URL with redirect_uri = http://127.0.0.1:<port>.
 *   3. Open the user's default browser to that URL (shell.openExternal).
 *   4. Google redirects back to the loopback server with ?code=...
 *   5. Exchange the code for tokens; persist the refresh token (encrypted).
 *
 * This is Google's recommended flow for native desktop apps. No client secret
 * or token ever leaves the user's machine except in the direct TLS calls to
 * Google's own OAuth endpoints.
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { shell } = require('electron');
const { google } = require('googleapis');
const store = require('./store');

// Full mailbox access is required to permanently delete messages (messages.delete
// / batchDelete) and to read raw content for backup. Trash-only would need just
// gmail.modify, but we support permanent deletion to actually reclaim storage.
const SCOPES = ['https://mail.google.com/'];

function createOAuthClient(redirectUri) {
  const client = store.getClient();
  if (!client || !client.clientId || !client.clientSecret) {
    throw new Error(
      'Google OAuth client is not configured. Add your Client ID and Client Secret in Settings.'
    );
  }
  return new google.auth.OAuth2(client.clientId, client.clientSecret, redirectUri);
}

/**
 * Returns an authenticated OAuth2 client using the stored refresh token, or
 * null if the user has not signed in yet.
 */
function getAuthorizedClient() {
  const refreshToken = store.getRefreshToken();
  if (!refreshToken) return null;
  const oauth2Client = createOAuthClient('http://127.0.0.1'); // redirect unused for refresh
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  // Persist token rotations Google may issue.
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) store.setRefreshToken(tokens.refresh_token);
  });
  return oauth2Client;
}

function htmlResponse(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6edf3;
  display:flex;height:100vh;align-items:center;justify-content:center;margin:0}
  .card{text-align:center;max-width:420px;padding:32px;border:1px solid #233;border-radius:12px}
  h1{font-size:20px}p{color:#9fb0c0}</style></head>
  <body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Performs the interactive sign-in. Resolves with the account profile.
 */
function signIn() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let settled = false;

    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1`);
        if (reqUrl.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const error = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');

        if (error) throw new Error(`Authorization denied: ${error}`);
        if (returnedState !== state) throw new Error('State mismatch — possible CSRF, aborting.');
        if (!code) throw new Error('No authorization code returned.');

        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}`;
        const oauth2Client = createOAuthClient(redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        if (tokens.refresh_token) {
          store.setRefreshToken(tokens.refresh_token);
        } else if (!store.getRefreshToken()) {
          throw new Error(
            'Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.'
          );
        }

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const email = profile.data.emailAddress;
        store.setEmail(email);

        res.writeHead(200, { 'Content-Type': 'text/html' }).end(
          htmlResponse('Signed in', `You are connected as ${email}. You can close this tab and return to the app.`)
        );

        settled = true;
        server.close();
        resolve({ email, messagesTotal: profile.data.messagesTotal });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(
            htmlResponse('Sign-in failed', err.message)
          );
        }
        settled = true;
        server.close();
        reject(err);
      }
    });

    server.on('error', (err) => {
      if (!settled) reject(err);
    });

    // Listen on a random free port on the loopback interface only.
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      let oauth2Client;
      try {
        oauth2Client = createOAuthClient(redirectUri);
      } catch (err) {
        server.close();
        reject(err);
        return;
      }
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force refresh_token issuance
        scope: SCOPES,
        state,
      });
      shell.openExternal(authUrl);
    });

    // Safety timeout so the loopback server never lingers forever.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        reject(new Error('Sign-in timed out after 5 minutes.'));
      }
    }, 5 * 60 * 1000).unref();
  });
}

async function signOut() {
  const refreshToken = store.getRefreshToken();
  if (refreshToken) {
    try {
      const client = getAuthorizedClient();
      if (client) await client.revokeToken(refreshToken);
    } catch (err) {
      console.warn('Token revocation failed (continuing local sign-out):', err.message);
    }
  }
  store.signOut();
}

module.exports = { signIn, signOut, getAuthorizedClient, SCOPES };
