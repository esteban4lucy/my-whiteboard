// My Whiteboard – configuration. This is the ONLY file you need to edit.
// See README.md › "One-time setup" for how to get a Client ID (free).
window.WB_CONFIG = {
  // OAuth 2.0 Web Client ID from Google Cloud Console (APIs & Services › Credentials).
  // Leave as-is to run in local-only mode (everything works, nothing syncs to Drive).
  CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',

  // Only this Google account may sign in. Set to '' to allow any account
  // (the OAuth consent screen in "Testing" mode already limits it to listed test users).
  ALLOWED_EMAIL: '',

  // Drive folder that holds everything. The id below is the "Whiteboard" folder
  // created in your My Drive. If it is missing or not accessible, the app looks
  // for a top-level folder named FOLDER_NAME and creates it if needed.
  ROOT_FOLDER_ID: '11C9mAo7-4w-oWULU_HL98k3_knVlI7jQ',
  FOLDER_NAME: 'Whiteboard',

  // Version history: how many snapshots to keep per board, and the minimum gap
  // between automatic snapshots (conflicts and "Save version now" always snapshot).
  MAX_VERSIONS: 5,
  VERSION_INTERVAL_MINUTES: 10,

  // Automatic background sync check while the app is open (seconds).
  POLL_SECONDS: 60,
};
