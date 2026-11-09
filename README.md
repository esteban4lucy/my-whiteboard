# My Whiteboard

A private, offline-first, Mural-style whiteboard that runs in your browser on phone, tablet and desktop, and keeps everything in your Google Drive folder **Whiteboard**.

* **App URL (bookmark this):** https://esteban4lucy.github.io/my-whiteboard/
* **GitHub repo:** https://github.com/esteban4lucy/my-whiteboard (public; contains code only, never your data)
* **Hosting:** GitHub Pages, deployed from the `main` branch (repo root)
* **Drive folder:** https://drive.google.com/drive/folders/11C9mAo7-4w-oWULU_HL98k3_knVlI7jQ
* **Source code:** `Whiteboard/source/` (zip plus the individual files)

---

## 1. Why this approach (Option A: Progressive Web App)

* **It's the only option that works offline from the same bookmarked link.** After the first visit, a *service worker* stores the whole app on the device, so the URL opens with no connection, like an installed app. Apps Script web apps (Option B) can't do this, because they always load from Google's servers. Option C (local files) can't be the same URL on every device.
* **No server and nothing to pay for.** It's plain static files (HTML/CSS/JS, no build step and no third-party libraries). Your browser talks directly to the Google Drive API with your own Google sign-in. Hosting is free (GitHub Pages).
* **Your data lives only in your Drive folder** and on the devices where you use the app.

## 2. Architecture

```
 Browser (phone / tablet / desktop)
 ┌───────────────────────────────────────────────────────────────┐
 │  index.html + js/*.js     the app (canvas whiteboard, vanilla JS) │
 │  sw.js                    service worker: caches the app → opens offline │
 │  IndexedDB "my-whiteboard"  LOCAL SOURCE OF TRUTH:              │
 │     boards · templates · pictures (blobs) · settings          │
 │  sync engine (js/sync.js) ⇄ Google Drive API v3 (js/drive.js)   │
 └───────────────────────────────────────────────────────────────┘
                     │  HTTPS, OAuth token from Google Identity Services
                     ▼
 Google Drive › Whiteboard/   (JSON + pictures, see §3)
```

| File | Role |
|---|---|
| `index.html`, `css/app.css` | Layout: top bar, bottom toolbar, boards drawer, dialogs. Mobile-first, with touch targets of 38–48 px. |
| `config.js` | **The only file you edit:** OAuth Client ID, allowed e-mail, folder id, version settings. |
| `js/app.js` | UI, tools, gestures (pinch/pan), boards, search, templates, export, sign-in. |
| `js/render.js` | Canvas drawing for live view and exports; hit-testing. |
| `js/db.js` | IndexedDB wrapper. |
| `js/sync.js` | Offline→online sync, conflict handling, version history. |
| `js/drive.js` | Google Drive adapter (GIS token + Drive REST v3 via `fetch`). |
| `js/mockdrive.js` | Fake Drive used only by automated tests (`?mock=1`). The normal app never loads it. |
| `js/export.js` | PNG / PDF / JSON export (the PDF writer is built in, with no library). |
| `js/templates.js` | Built-in templates. |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: offline cache and "Add to Home Screen". |

## 3. Drive folder structure

```
Whiteboard/
├── README (this file)
├── boards/      one JSON file per board:  "<Board name>.board.json"
├── versions/    last 5 snapshots per board: "<Board> — <date> UTC (<reason>).json"
├── images/      pictures you uploaded to boards
├── templates/   templates you saved ("<Name>.template.json"); copies of the 6 built-ins
├── documents/   optional: documents you upload from the app to link on boards
└── source/      the app's source code (zip + files) so you can edit/redeploy it
```

A board file contains `{ id, name, background, items[], imageFiles{}, updatedAt }`. Items are strokes, shapes, text, sticky notes, pictures and link cards. The app identifies a board by the `boardId` stored in the file's Drive properties, so renaming a file in Drive does not break anything. **Organisation:** boards form one flat list (newest first) with full search. This is the simplest structure that stays reliable.

## 4. Setup status

**Done:** the OAuth Client ID is set in `config.js` (`577841464326-tnald458sqaeomld1sj5laqk5d8gtufl.apps.googleusercontent.com`). Its authorised JavaScript origin is `https://esteban4lucy.github.io`, and the app is live at https://esteban4lucy.github.io/my-whiteboard/. The steps below are kept as a reference in case you ever need to recreate the client or host it elsewhere.

### 4a. Create the Google OAuth Client ID
1. Go to <https://console.cloud.google.com/> (signed in with your Google account) › project picker › **New project** › name it `My Whiteboard` › Create.
2. **APIs & Services › Library** › search **Google Drive API** › **Enable**.
3. **APIs & Services › OAuth consent screen** (now called *Google Auth Platform*):
   * User type **External** › App name `My Whiteboard`, support e-mail = your address, developer contact = your address › Save.
   * **Data access / Scopes:** add `https://www.googleapis.com/auth/drive`.
   * **Audience / Test users:** add **your own Gmail address**. Leave publishing status on **Testing**.
4. **APIs & Services › Credentials › Create credentials › OAuth client ID**:
   * Application type **Web application**, name `My Whiteboard web`.
   * **Authorised JavaScript origins:** the origin of the hosting URL, with **no path and no trailing slash**, e.g. `https://<your-github-username>.github.io`. To try the app locally as well, also add `http://localhost:8000`.
   * Authorised redirect URIs: leave empty. Click Create and copy the **Client ID** (`…apps.googleusercontent.com`). No client secret or API key is needed.
5. Open `config.js` and paste it: `CLIENT_ID: '1234-abc.apps.googleusercontent.com'`. Optionally set `ALLOWED_EMAIL: 'you@gmail.com'`, which makes the app refuse any other Google account.
6. In `sw.js`, bump `VERSION` (e.g. `v1.0.1`) whenever you change any file, so devices pick up the change.

> **"Google hasn't verified this app" warning:** this is expected for a personal app. Click **Continue**. In *Testing* mode Google may ask you to approve again about once a week. To avoid that, you can set the publishing status to *In production* without verification; it remains limited to you and still shows the warning screen.

### 4b. Hosting (GitHub Pages: already set up)
* Repo: https://github.com/esteban4lucy/my-whiteboard. **Settings › Pages** is set to *Deploy from a branch* › `main` / `(root)`.
* **To update the app:** edit the files, bump `VERSION` in `sw.js` (e.g. `v1.0.1` → `v1.0.2`), then commit and push to `main`. GitHub Pages redeploys in about a minute, and open devices show "A new version is ready – Reload".
* The app uses relative paths only, so it works under the `/my-whiteboard/` sub-path. The empty `.nojekyll` file must stay in the repo.
* The repository holds only code, never your data, so being public is fine. The Client ID is not a secret.

## 5. Using it

* **Open:** go to the URL. On a new device, tap **Sign in with Google** once; your boards then download from Drive.
* **Install:** on iPhone, open Safari › Share › *Add to Home Screen*. On Android/Chrome, use ⋮ › *Install app*. On desktop Chrome/Edge, click the install icon in the address bar.
* **Tools (bottom bar):** Select/move · Pen · Highlighter · Eraser (removes whole strokes/shapes) · Shapes (tap again to pick rectangle, ellipse, line or arrow) · Text · Sticky note (tap again to pick its colour) · **+** Insert (upload a picture, picture from URL, link a document, frame / section, sticky note) · Colour & thickness.
* **Selecting an item** shows a small action bar: colour, text format (Aa), edit, tags/due date/checklist (notes), open/preview (links), frame options, multi-select, connect, align, put in a frame, group/ungroup, lock, duplicate, layers, delete. On a phone the bar wraps onto two rows. Drag an item to move it; drag the round handle to resize it.
* **Touch:** use one finger to draw or move. Use two fingers to pan and zoom. With the Select tool, dragging empty space pans. Double-tap a note to edit it.
* **Desktop:** the mouse wheel pans and Ctrl+wheel zooms. Space+drag also pans. Shortcuts: V P H E S T N, Ctrl+Z, Ctrl+Shift+Z, Delete, Ctrl+F, Ctrl+A (select all unlocked), Ctrl+G / Ctrl+Shift+G (group/ungroup), Ctrl+L (lock/unlock), Ctrl+B / Ctrl+I (bold/italic) and Esc (clear selection). You can paste pictures, links or text, and drag and drop picture files.
* **Links and documents:** + › *Link a document* lets you paste any Google Doc, Sheet or Slides link, Drive file link or web page. You can also choose a file from `Whiteboard/documents` or upload one there. The card's **Open ↗** button opens the original, and **Preview** embeds it while you're online.
* **Pictures:** *Upload picture* stores the image on the device right away and uploads it to `Whiteboard/images` on the next sync. *Picture from URL* keeps the link and also caches a copy so it shows offline.
* **Boards (☰):** create, switch, rename, duplicate and delete. Tap the board title to rename it. Deleted boards go to the Drive bin, where they can be recovered for 30 days.
* **Templates:** ☰ › **+ New board** lets you pick Blank, Meeting Notes, Brainstorm, Project Plan, **Kanban**, Weekly Review or one of your own. **Kanban** comes with four locked column frames (Backlog, To do, Doing, Done ✓) and starter notes, so you can drag notes between columns without moving the columns. To make your own, customise any board and use ⋯ › **Save board as template**. Saving with the same name updates the template.
* **Search (🔍):** searches every board's sticky notes, free text, link titles and board names. Results are grouped by board; tap one to jump to it.
* **Export (⋯):** PNG image, PDF (always light, for printing), or JSON backup. *Import JSON* recreates a board.
* **Theme:** the ◐ button, or ⋯ › Dark/Light mode. The choice is remembered on each device.

### Lock, group & format text

**Lock** (e.g. Kanban columns that must not move)
* Select the item(s) › tap 🔒 in the action bar (desktop: Ctrl+L). Locked items can't be moved, resized, erased, edited or deleted, and a normal tap/drag on them pans the board, so you can freely drag sticky notes on top of a locked column.
* **To unlock:** *phone* – press and hold the locked item for about half a second, then tap **🔓 Unlock**. *Desktop* – the same long-press (hold the mouse button) or Ctrl+L after selecting. *Everything at once* – tap the Select tool again › **Unlock all**, or ⋯ › **Unlock all items on this board**.
* A selected locked item shows a 🔒 badge and the bar reads "🔒 Locked (n)".

**Select several & group**
* *Desktop:* Shift-click (or Ctrl/⌘-click) to add/remove items; Shift+drag on empty space draws a selection box; Ctrl+A selects every unlocked item.
* *Phone:* tap the Select tool again › **Multi-select** (or the multi-select button — two ticked squares — in the action bar). A banner shows "N selected"; tap items to add or remove them, drag on empty space to box-select, tap **Done** to finish. The action bar sits just above the toolbar while in this mode.
* Tap **Group** (Ctrl+G) to join them: tapping any member selects the whole group, and it moves, resizes (round handle, uniform scale), duplicates, locks and unlocks together. **Ungroup** (Ctrl+Shift+G) separates them. Groups and locks are saved in the board JSON and sync to your other devices.

**Format text** (free text and sticky notes)
* Select the text or note(s) › tap **Aa**: size **S / M / L / XL** (or A− / A+ for fine steps), **B** bold, *I* italic, and a text colour (for notes, "ink" is the default dark text). Works on several items or a group at once (desktop: Ctrl+B / Ctrl+I). Formatting shows in PNG/PDF exports, and every change can be undone.

### Connectors, Kanban notes, frames, arranging & layers

**Connectors (arrows that stay attached)**
* Pick the Arrow (or Line) shape and drag from one note/shape to another: both ends attach and follow the items when you move them.
* *Phone:* Select › tap again › Multi-select › tap two items › **Connect** (the boxes-and-arrow button). *Desktop:* Shift-click two items › **Connect**.
* Select an arrow and drag one of its round end handles to re-attach it to another item, or into empty space to detach that end.

**Kanban-friendly notes**
* **Snap into columns:** drop a sticky note on a column (a tall, narrow rectangle or frame, like the Kanban template's columns): it centres itself in the column below the header and stacks under the notes already there instead of overlapping them. To turn it off, use ⋯ › *Snap notes into columns*.
* **Tags & due date:** select note(s) › tag button › type tags (comma-separated) and pick a due date (or tap Today / Tomorrow / +1 week) › **Save**. They show as chips at the bottom of the note: the due date turns orange on the day and red when overdue. Search also finds tags.
* **Checklists:** start a line in a note with `[ ] ` (or use tag button › **☑ Add checklist item**). Tap the box to tick it (`[x]`); ticked lines are struck through.

**Frames / sections**
* **+ › Frame / section** adds a named area, or select items › **Frame** button to wrap them. Drag a frame by its title bar and everything inside moves with it. Tapping or dragging inside a frame's empty area pans as usual.
* In the action bar: rename (or double-click the title), change the colour, collapse/expand (or tap the ▾/▸ at the right of the title bar). Collapsing hides the frame's contents, and the frame shows how many items are hidden.
* **Jump:** the frames button (bottom-right, next to the mini-map) lists the frames (ordered top-to-bottom, then left-to-right). Tap one to jump to it.
* **Mini-map:** the map button (bottom-right) shows the whole board with your current view. Tap or drag on it to move around.
* **Present mode:** frames button › *Present from the start* (or ⋯ › *Present frames*, or select a frame › ▶). Each frame fills the screen like a slide. *Phone:* swipe left/right or tap ◀ ▶, then ✕ to leave. *Desktop:* arrow keys / Space / Page Up/Down, Esc to leave.

**Align, distribute & snap to grid**
* Select 2+ items › **Align**: left, centre, right, top, middle or bottom. With 3+ items you can also **distribute** them evenly across or down. Groups count as one unit.
* ⋯ › **Snap to grid** (per device): moved items, new notes and new shapes land on a 20-px grid.

**Layers & background**
* Select › **Layers** button: bring to front, bring forward, send backward, send to back (desktop: Ctrl+] / Ctrl+[, add Shift for front/back).
* **Move to background layer** puts an item (e.g. a big picture, a coloured area or a diagram) beneath everything else. Then use **Lock background layer** (in the same menu or in ⋯) so you can't move it by accident: dragging on it pans, and notes move freely on top. ⋯ › *Unlock background layer* (or *Unlock all*) releases it.

All of these can be undone, are saved in the board JSON and sync to your other devices. Older boards open unchanged.

## 6. Offline and sync behaviour

* **Every change is saved to the device first (IndexedDB)**, so nothing waits for the network. After a short pause the sync engine pushes changes to Drive.
* **The status pill** (top right) shows: `Synced` (green), `Syncing…`, `Saved locally` (changes waiting), `Offline · N` (N changes waiting), `Sign in` (session expired: tap it), `Sync error` (tap to retry) or `Local only` (no Client ID configured). **Tap the pill at any time to force a sync.** ⋯ › *Sync now* does the same.
* **Sync runs** automatically after edits, when the device comes back online, when you return to the tab, and every 60 s while the app is open. It pushes local changes and pulls changes made on your other devices, including pictures, which are downloaded so they also work offline.
* **The app works offline right after the first visit.** ⋯ › *Offline status & help* confirms that "Offline app: ✅ ready". The app also asks the browser to keep its storage persistent.
* **Conflicts (last-write-wins):** if the same board changed on two devices before syncing, the copy with the most recent edit wins. The other copy is never lost: it is saved to version history, and a notice explains what happened, with a **History** button.
* **Deleted elsewhere:** a board deleted on another device disappears here too, unless this device has unsynced edits to it, in which case it is re-uploaded.
* **Sign-in tokens** last about an hour. When one expires, your edits keep saving locally and the pill shows **Sign in**. Tap it; usually there is no prompt.

## 7. Version history

* The last **5** versions of each board are kept in `Whiteboard/versions/`, and older ones are moved to the Drive bin. A version is saved:
  * automatically, at most every **10 minutes** while you edit and sync,
  * when a board is created,
  * whenever a conflict overwrites a copy,
  * before you restore an older version,
  * whenever you tap **Save version now**.
* **To roll back:** open the board › ⋯ › **Version history** › **Restore** next to the version you want. The current state is saved as a version first, so a restore can itself be undone. Restoring needs a connection.
* Each version is plain JSON, so you can also download one from Drive and use ⋯ › *Import JSON*.
* You can change the settings in `config.js`: `MAX_VERSIONS` and `VERSION_INTERVAL_MINUTES`.

## 8. Privacy and security

* Only Google accounts listed as test users on your OAuth consent screen can sign in, and `ALLOWED_EMAIL` restricts it further to you. There are no sharing features.
* The app has no backend. Drive data goes straight from your browser to Google, and nobody else has a copy.
* **Why the full `drive` scope:** the narrower `drive.file` scope only lets an app see files it created itself. Your `Whiteboard` folder was created separately, and you link existing Docs and Sheets, so `drive.file` would not see them. The app itself only reads and writes inside `Whiteboard/`, plus the names of documents you link.
* The local copy lives in the browser's storage on each device. ⋯ › **Sign out** offers *Sign out & clear*, which removes it from a device. The short-lived access token is kept in that browser's local storage.

## 9. Changing the app later

Edit the files, bump `VERSION` in `sw.js`, then commit and push to `main` in https://github.com/esteban4lucy/my-whiteboard (GitHub Pages redeploys automatically). Open devices show "A new version is ready – Reload". Keep a copy in `Whiteboard/source/`.

## 10. Known limits (v1)

* Box-select is a rectangle (no free-form lasso). Connectors are straight (no elbow or curved routing). A multi-selection or group resizes uniformly from its top-left corner.
* The eraser removes whole strokes and shapes rather than partial pixels.
* Some websites refuse to be shown in the Preview frame; **Open ↗** always works.
* Pictures added by URL from sites that block cross-site access can't be included in PNG/PDF exports. Upload them instead.
* Version history and documents in `Whiteboard/documents` need a connection to view.

## 11. How it was tested

These automated browser tests ran in headless Chrome with real touch events, with the app served under a `/my-whiteboard/` sub-path as on GitHub Pages:
* **Connectors, Kanban notes, frames, arrange & layers (desktop + 390 px phone):** arrows attach and follow notes, end handles detach and re-attach, Connect button, duplicated arrows stay wired to the copies, column snapping (centring, stacking, on/off), tags and due dates, checklist ticking, search by tag, PNG export, frames carry their contents, collapse/expand, put in a frame, mini-map jump, present mode (keys, buttons, swipe), align and distribute, snap to grid, layer order, background layer and its lock, undo for every action, persistence through Drive sync, and older boards.
* **Lock, group & text format (desktop + 390 px phone):** Shift-click and box-select, phone multi-select mode, group move/resize, lock/unlock (incl. long-press on phone and *Unlock all*), locked items can't be moved, erased or deleted, Ctrl+A/G/L/B/I, text size/colour/bold/italic, undo/redo of every action, persistence through Drive sync and reload, PNG/PDF export, the Kanban template, and older boards without the new fields.
* **Whiteboard features:** drawing tools, notes, shapes, text, eraser, undo/redo, zoom/pan, pinch, boards, templates, search, PNG/PDF/JSON export and import, and the theme setting.
* **Offline cycle with a simulated Drive:** the app reloads while offline, offline edits survive, it syncs on reconnect, remote changes are pulled, both conflict directions are handled, versions are pruned to 5 and restore works, deletions sync, and a "new device" first run downloads boards and pictures.
* **The real Drive adapter** against an emulated Drive v3 REST API: folder discovery and creation, multipart uploads, UTF-8, pulls, version pruning, token expiry and re-sign-in, recovery after the folder is trashed, and rejection of other accounts.
* **Not covered:** real Google sign-in and live Drive calls can't be automated. These are checked by hand on first use after the Client ID is added.
