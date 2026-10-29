# Choose a demo by hand

Use this when start.mjs returns `setup_failed`. Its `seen` field lists the Navattic text it found. All of these are plain clicks; take a new snapshot before each one.

1. For a new demo (the default): click "New demo" and type the name into "Name your demo" (the user's name for it, else the app's host and the time). For an existing one: click "Add to existing demo", then the "Product demo" combobox, then the demo's option.
2. Check radio "Web capture" is `value: true` and checkbox "Click to capture" is `value: false` (it captures every click; Shift+click gives control over which clicks count). Click either one only if it's wrong.
3. Click "Start capturing".
4. "Start capturing" makes Navattic reload the tab itself. Snapshot every second; only if the bar is still missing after about 12 s, `browser_reload` once and snapshot again. Done when the "Capture" and "Finish" buttons show with a counter of 0.
