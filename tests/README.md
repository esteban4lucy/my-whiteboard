# Automated tests (not needed to run the app)

Requires Node 18+ and Chrome. From the folder that CONTAINS `my-whiteboard/`:

    python3 -m http.server 8765 --bind 127.0.0.1 &
    cd my-whiteboard/tests && npm i playwright-core
    node test.mjs          # desktop: tools, boards, templates, search, export, offline + sync + conflicts + versions (mock Drive)
    node touch.mjs         # phone: touch drawing, pinch/pan, notes, new-device first run
    node realadapter.mjs   # real drive.js against an emulated Drive v3 REST API + fake Google sign-in
    node features.mjs      # lock/unlock, multi-select, group, text formatting, Kanban (desktop + 390px phone)
    node features2.mjs     # connectors, Kanban notes, frames/mini-map/present, align/grid, layers (desktop + 390px phone)
    node features3.mjs     # copy/paste across boards, camera, dictation, board picker, handwriting/shapes, Drive inbox new-board + add-items (desktop + 390px phone)

Edit `executablePath` in the scripts if Chrome is not at /usr/bin/google-chrome.
