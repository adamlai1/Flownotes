# Siri voice capture setup (v1.3)

One-time Xcode work to add "Add a note to Nubble" — an App Intent that Siri
and the Shortcuts app can run **without opening the app**. All source files
already exist in the repo; this checklist adds one of them to the App target
and changes two build settings, so `project.pbxproj` is only ever touched by
Xcode itself.

**This is v1.3. Do not do any of this in the build being submitted now.**
Everything on main today is inert without step 4: the plugin is registered
but its queue is never written, the web consumer finds an empty queue, and
`INAlternativeAppNames` in Info.plist does nothing until an
AppShortcutsProvider is compiled in.

**Sources:**
- App-target side (already in place, nothing to add in Xcode):
  `VoiceCaptureStore` and `VoiceCapturePlugin` live inside
  `App/App/SceneDelegate.swift` next to `SharedImportPlugin`, and
  `MainViewController` already registers the plugin — so main compiles today,
  before any of these steps.
- The intent (the TWO files this checklist adds to the target), both in
  `App/App/` next to `SceneDelegate.swift` — **these are the compiled
  copies; there is no template folder**:
  - `App/App/AddNoteIntent.swift` — `AddNoteIntent` plus `NubbleShortcuts`,
    the App Shortcuts provider that supplies the Siri phrases.
  - `App/App/BubbleEntity.swift` — the optional bubble parameter ("add a
    note to Ideas in Nubble"): `BubbleEntity`, its query, and
    `VoiceBubbleSync`, which the plugin calls by class name to tell Siri the
    bubble list changed.

  (They used to live in `ios/voice-capture-src/`. Xcode's *Add Files* copied
  them into `App/App/` rather than referencing them, leaving two copies of
  which only the `App/App/` one built. The originals were removed so an
  edit can only ever land in the copy that compiles.)
- Info.plist: `INAlternativeAppNames` (already in place). `.applicationName`
  in a phrase matches `CFBundleDisplayName` (now "Nubble") *and* every entry
  here, so this is belt-and-braces: "Add a note to Nubble" keeps working
  even if the display name changes. Its shape is an **array of dicts**, each
  with an `INAlternativeAppName` string:

  ```xml
  <key>INAlternativeAppNames</key>
  <array>
      <dict>
          <key>INAlternativeAppName</key>
          <string>Nubble</string>
      </dict>
  </array>
  ```

  A bare array of strings is valid plist XML — `plutil` passes it — but the
  `AppIntentsSSUTraining` build step rejects the structure with *"Unable to
  parse Info.plist"* and the build fails. Leave the dict form alone.
- Web side: already wired (`src/lib/voiceCapture.js` + the consumer in
  `App.jsx`).

**No new target.** The intent is compiled into the App itself. With
`openAppWhenRun = false`, iOS runs it in the background: if Nubble isn't
running it is launched **without a scene** — no window, no WKWebView, no
React — writes the capture, and suspends. If Nubble is already running, the
intent runs inside that process and the note lands in the web layer at once.
This is why there is no App Intents *extension* target: an extension would
need an iOS 17 floor and would force the intent type into both bundles (the
shortcuts provider must live in the app), for no gain over the in-app run.

> ## ⚠️ `git pull` alone is NEVER enough on the Mac
>
> The web bundle Xcode packages lives in `ios/App/App/public`, which is
> **untracked** — git never touches it. After **every** pull, before building:
>
> ```
> npm run build && npx cap sync ios
> ```
>
> Skip it and Xcode happily ships whatever JavaScript was synced last time,
> while the Swift side is current. That mismatch has now caused **two
> separate multi-hour debugging sessions** (share extension: app opened with
> an empty Import; voice capture: queue filled, nothing ever drained). Both
> times the native side was fine and the fix was this one command. If a
> symptom looks like "native works, web side does nothing", run it before
> reading a single log line.

**Prereqs:** Mac with Xcode 15+, signed into the team (749R476GNN), a device
on **iOS 16+**. Run `npm run build && npx cap sync ios` first (see above).

**Updating an existing install:** unlike the share extension there is no
pasted copy — `App/App/AddNoteIntent.swift` and `App/App/BubbleEntity.swift`
are tracked in git AND are what Xcode compiles, so edit them in place, pull
on the Mac, rebuild. Web-side changes still need
`npm run build && npx cap sync ios` or the native bundle goes stale.

---

## Recorded decision: minimum iOS goes from 15 to 16

App Intents require iOS 16. Raising the App target's deployment target to
16.0 **drops iOS 15 devices** (iPhone 6s / 7 / SE 1st gen and earlier). This
was decided deliberately for v1.3, not inherited as a side effect of the
feature: the alternative — keeping 15.0 and annotating every intent type with
`@available(iOS 16, *)` — keeps a floor nobody is on at the cost of a build
that must compile two ways. Existing iOS 15 installs keep working; they just
stop receiving updates from 1.3 on.

---

## Part A — Build settings (~5 min)

1. Open `ios/App/App.xcodeproj` in Xcode.

2. **Deployment target.** Project → target **App** → *General* → *Minimum
   Deployments* → **iOS 16.0**. Then target **ShareExtension** → the same
   **16.0** (an extension whose target is below its host's builds, but keep
   them equal — the share doc's step 7 rule).

   Do **not** change `CapApp-SPM/Package.swift` (`.iOS(.v15)`): a package
   floor below the app's is fine, and touching it re-resolves the package.

3. **Version.** Target **App** → *General* → *Version* → **1.3** (bump
   *Build* as usual). The share extension inherits `MARKETING_VERSION`, so it
   follows automatically — confirm on its General tab.

   **App Groups** needs nothing: the App target already has
   `group.com.adamlai.flownotes` from the share extension setup (confirm it is
   still the only group under *Signing & Capabilities*). The intent runs in
   the app process, so that one entitlement covers it. No Siri capability is
   required for App Intents / App Shortcuts.

## Part B — Add the intent (~5 min)

4. **Add the files to the App target.** Both already exist on disk in
   `ios/App/App/` (they come with `git pull`); this step only tells Xcode
   to compile them. In the navigator select the **App** group (the folder
   holding `SceneDelegate.swift`) → *File → Add Files to "App"…* → select
   BOTH `ios/App/App/AddNoteIntent.swift` and `ios/App/App/BubbleEntity.swift`.
   - The files are already inside the group's folder, so *Copy items if
     needed* makes no copy either way — leave it **unchecked** regardless.
   - *Add to targets*: **App** only. Not ShareExtension.

   Xcode writes the file references and build-phase entries into
   `project.pbxproj` — commit that change from the Mac so the next checkout
   builds the intent without repeating this step.

   **If Xcode already copied them into `App/App/` before this move** (the
   original checklist pointed at `ios/voice-capture-src/`, and *Add Files*
   copied rather than referenced): on the Mac, delete the two untracked
   copies BEFORE pulling — `git pull` refuses to overwrite untracked files
   at the same paths — then pull. The tracked files land at exactly the
   paths the project already references, so nothing else changes:

   ```
   rm ios/App/App/AddNoteIntent.swift ios/App/App/BubbleEntity.swift && git pull
   ```

   Both or neither: `AddNoteIntent.swift` references `BubbleEntity`, so
   adding only the intent file fails to compile.

5. **Build the App scheme.** Expected: no errors, and a build log line from
   `appintentsmetadataprocessor` (Xcode extracts the intent + shortcut
   metadata into `Metadata.appintents` inside the bundle). If that line is
   missing the file didn't make it into *Compile Sources* — check target
   membership in the File Inspector.

   If the build says `'AppIntent' is only available in iOS 16.0 or newer`,
   step 2 didn't take on the App target.

   If it fails at **`AppIntentsSSUTraining`** with *"Unable to parse
   Info.plist"*, `INAlternativeAppNames` has lost its dict shape (see
   *Sources* above) — the plist is well-formed XML, so `plutil` won't catch
   it; only the App Intents processor does.

6. **Run on the device once.** The app must behave exactly as before. This
   install is what registers the App Shortcut with the system — from here on
   the phrase works, including after a delete-and-reinstall, with no launch.

## Part C — Verify on device

Filter **Console.app** on subsystem `com.adamlai.flownotes.VoiceCapture`
(process: `App`). Only lengths and ids are logged, never the spoken text.
Two categories: `intent` (the intent ran) and `store` (the queue).

0. **Queue write verification — do this first.** With Console streaming,
   **force-quit Nubble**, then say to Siri: *"Add a note to Nubble"*. Siri
   asks *"What's the note?"* — answer with a sentence. Expected within a
   second, from a process named `App` that has **no UI on screen**:

   ```
   capture <id> written: <N> chars, queue depth 1
   intent stored capture <id> (<N> chars)
   ```

   and Siri says **"Added to Nubble"**. Nubble must **not** come to the
   foreground. If the lines are missing but Siri said "Added", the intent ran
   in a process Console isn't showing — remove the process filter and keep
   just the subsystem. If instead you see `App Group unavailable` or
   `FAILED readback`, **stop here**: the App Group capability is missing on
   the App target (Part A) and nothing below can pass.

   Now open Nubble from the icon. Expected: the toast **"Added a note from
   Siri"**, the note at the root of the current project (canvas, no bubble),
   and in Console:

   ```
   list: 1 queued capture(s)
   ack: removed 1 of 1
   ```

   **The ack line is the tell.** `list` without `ack` means the web side
   received the captures but did not confirm persisting them — the queue is
   intact, and that is a bug in `App.jsx`'s consumer, not in the hand-off.

- **Several notes before opening.** Force-quit Nubble. Add three notes via
  Siri in a row (queue depth 1, 2, 3 in Console). Open Nubble → toast "Added
  3 notes from Siri", three root-level notes, in the order spoken, each
  dated **when it was spoken**, not when the app opened. Console:
  `list: 3 queued capture(s)` … `ack: removed 3 of 3`.
- **Nubble open in the foreground.** Leave it on the canvas, invoke Siri
  (side button), add a note. The note appears **immediately** — no
  background/foreground cycle — with the toast. Console shows the `store`
  write, then `list`/`ack` within a second.
- **Nubble in the background.** Background it, add a note via Siri, return
  via the app switcher → the note is there on return.
- **Shortcuts app.** Open Shortcuts → search **"Add a Note"** → Nubble's
  action is listed with a *Note* text field. Build a shortcut, run it: same
  result, no app launch. Also check the Shortcuts *App Shortcuts* tile for
  Nubble lists all five phrases.
- **Empty note.** *"Add a note to Nubble"* → say nothing / cancel → nothing is
  queued (Siri re-asks or gives up; no `written` line).
- **Fresh install (works before first launch).** Delete Nubble. Reinstall
  from Xcode but do **not** open it. *"Add a note to Nubble"* → "Added to
  Nubble", and Console shows the write. Then open Nubble for the first time:
  the note appears **only after** you get past the login screen — as a guest,
  immediately on the canvas; signed in, see the next test.
- **The guard: captured before sign-in, then sign in to an account with
  cloud data.** This is the one that matters. Sign out (so the login screen
  shows on next launch), force-quit, add a note via Siri. Open Nubble — on
  the **login screen** nothing happens and Console shows **no `list` line**
  (the queue is not touched while the merge question could still be asked).
  Sign in to an account that already has notes. Wait for the sync to finish
  (status pill goes to synced). **Then** the toast appears and the note is at
  the root of the project that was restored — Console `list`/`ack` only now.
  Repeat once choosing **"Use cloud"** in the merge dialog if one appears:
  the spoken note must still land afterwards, never be discarded with the
  local data. A spoken note that vanishes on this path is a real bug in the
  readiness gate (`voiceReady` in `App.jsx`), not in the hand-off.
- **Offline at launch, signed in.** Airplane mode on, force-quit, add a note
  via Siri, open Nubble. The note does **not** appear yet (Console: no
  `list`) — the initial sync couldn't run, so the merge question is still
  open. Airplane mode off, force-quit, relaunch → sync runs → the note lands.
  This is loss-free by design; captures wait as long as they have to.
- **Sync.** After any of the above while signed in, open Nubble on another
  device (or the web): the spoken note is there, at the root, with the
  spoken-at timestamp.
- **Nothing expires.** Add a note via Siri, don't open Nubble for a day, open
  it → the note lands. (Contrast the share flow's 10-minute window: a share
  is an abandoned *import*; a spoken note is a *committed* note.)
### Filing into a bubble

The bubble in "add a note to *Ideas* in Nubble" is an App Entity backed by
a **mirror** of the device's bubbles that the app writes to the App Group
(`bubbles.json`) about a second after any bubble change, then asks Siri to
re-read (Console: `bubble mirror written: N bubble(s)`, category `store`).
Siri precomputes one phrase variant per mirrored bubble, so only bubbles in
the mirror are sayable. Names under 3 characters are left out on purpose.

**The audible rule, and why it matters more than filing:** when the intent
runs, Siri says **"Added to Ideas"** (filed) or **"Added to Nubble"** (root).
If you hear neither, Siri did not run the intent and **nothing was
captured** — say it again with the plain phrase. Every test below checks
what Siri *says*, not just what lands.

- **Plain phrase unchanged.** *"Add a note to Nubble"* → "What's the note?"
  → "Added to Nubble". Root, as before. Siri must **never** ask "Which
  bubble?" on this phrase — the parameter is optional.
- **Filed.** *"Add a note to Ideas in Nubble"* → "What's the note?" → **"Added
  to Ideas"**. Open Nubble: the note is inside Ideas, toast "Added a note to
  Ideas from Siri". Console `intent stored capture … bubble: by-id`.
- **Bubble in another project.** Name a bubble that lives in a project
  other than the one open. The note lands in *that* bubble in *that*
  project, not at the open project's root; the open project is untouched.
- **New bubble is sayable within seconds.** Create a bubble "Groceries" in
  the app. Wait ~2 s (Console: `bubble mirror written`). Background the app,
  *"Add a note to Groceries in Nubble"* → "Added to Groceries". If Siri
  doesn't know the name until a reinstall, `VoiceBubbleSync.refresh()` isn't
  being reached — see Troubleshooting.
- **Duplicate names (disambiguation).** Make two bubbles called "Ideas" in
  different places (e.g. one under Work). *"Add a note to Ideas in Nubble"* →
  Siri shows both, each with its path/project as the subtitle (e.g. *Work ·
  My Notes*) → pick one → "Added to Ideas" → the note is in the one you
  picked. Same on-screen list in the Shortcuts editor.
- **Stale mirror — bubble deleted after Siri learned it.** Create "Temp",
  wait for the mirror, then delete it and IMMEDIATELY (before the next
  mirror write lands) say *"Add a note to Temp in Nubble"*. Whether Siri
  still offers Temp or not: the outcome must be one of (a) "Added to Temp"
  then the note at **root** with toast *"…at root — no bubble called
  “Temp”"*, or (b) Siri doesn't run the intent and says so. **Never** silence
  after "What's the note?".
- **Stale mirror — bubble created on another device, not pulled yet.**
  Create "Remote" on the web app; do NOT open the iOS app. *"Add a note to
  Remote in Nubble"*. Listen carefully — this is the case to characterise:
  - Siri runs the plain intent (says "Added to Nubble") → captured at root.
    Good.
  - Siri asks "What's the note?", takes the text, and says "Added to
    Nubble" → the placeholder path (`bubble: by-name` in Console). Open the
    iOS app *after* it syncs: the note is **filed into Remote** by name.
  - Siri does something else (web search, "I can't help with that") → it
    must be **clearly audible/visible** that nothing was captured. If on
    this iOS version that response is quiet or ambiguous, record it here:
    that is the one path where a spoken thought can be lost, and the
    mitigation is the plain phrase.
- **Unsayable names are filtered.** With bubbles "F", "Gj", "G" present,
  the Shortcuts editor's bubble picker does not list them; *"Add a note to
  G in Nubble"* does not run the filed intent. Renaming "G" to "Gym" (3+
  chars) makes it appear after the next mirror write.
- **Filed capture while offline / gate closed.** Same as the plain cases:
  the capture waits with its bubble hint attached and files on release.

- **Share extension still works** (Part C of `SHARE_EXTENSION_SETUP.md`,
  the Apple Notes case is enough) — same App Group, different keys, no
  interaction, but the deployment-target change rebuilt it.

## Troubleshooting

- **Siri says "Added" (Console shows `written`, queue depth climbing) but
  opening Nubble does nothing — no toast, no notes:** rule out a stale web
  bundle FIRST, before any log filtering. See the warning at the top: the
  native bundle folder is untracked, so `git pull` leaves the app running
  JavaScript from before the consumer existed. Run
  `npm run build && npx cap sync ios`, rebuild in Xcode, open the app —
  the queue is intact and every waiting capture lands on that open. (This
  exact symptom cost a multi-hour session on 2026-09-03; the write side was
  fine the whole time.)
- **A new bubble isn't sayable until reinstall:** Siri's parameter cache
  isn't being refreshed. `VoiceCapturePlugin.setBubbles` looks up
  `VoiceBubbleSync` by class name and calls `refresh()`; if
  `BubbleEntity.swift` isn't in the App target that lookup silently finds
  nothing (step 4, both files). Confirm the mirror itself is written
  (Console `bubble mirror written`) — if it is, only the refresh is missing.
- **"Add a note to X in Nubble" lands at root with a "no bubble called"
  toast although X exists:** X was mirrored under an id the app can no
  longer find and no other bubble has exactly that name — a rename between
  Siri learning the bubble and the capture. The note is safe; move it.
- **Bundle is current, captures still don't land while signed in:** the
  readiness gate is holding them — by design when the initial sync didn't
  settle (offline at launch, or a sync error). Force-quit and relaunch
  online; a successful sync releases the queue. If the status pill shows
  synced and they still don't land, that's a bug in `voiceReady` in
  `App.jsx`; the queue is intact.

- **Siri says "I don't see an app for that" / phrase not recognised:** the
  App Shortcut isn't registered. Step 6 hasn't been run since step 4, or the
  metadata processor didn't run (step 5). Also check `CFBundleDisplayName`
  is still "Nubble" or `INAlternativeAppNames` is still in
  `App/App/Info.plist` in its array-of-dicts shape — the phrase matches
  either. Rebooting the device after a reinstall clears Siri's phrase cache.
- **Build fails at `AppIntentsSSUTraining`, "Unable to parse Info.plist":**
  `INAlternativeAppNames` is an array of strings instead of an array of
  `{ INAlternativeAppName: … }` dicts. Restore the form shown under
  *Sources*. `plutil -lint` passes either way, so don't use it as the check.
- **Siri opens Nubble instead of running in the background:** someone set
  `openAppWhenRun` to `true`, or an older build is installed. Also happens if
  the intent throws before its result — check Console for an `intent failed`
  line.
- **Siri says "Nubble couldn't save the note":** that is
  `VoiceCaptureError.appGroupUnavailable` spoken aloud — App Group missing
  on the App target, or the group ID doesn't match
  `group.com.adamlai.flownotes` exactly (hard-coded in `VoiceCaptureStore`).
- **Notes land only when Nubble is force-quit and relaunched, never while it
  is open:** `VoiceCapturePlugin` isn't receiving the store notification —
  `MainViewController` must register it (`registerPluginInstance`); check
  the storyboard still points at `MainViewController`.
- **Console shows `list` but never `ack`, note not visible:** the web
  consumer returned no ids. Look for `[voice] drain failed` in Safari's Web
  Inspector for the device. The queue is intact; fix and relaunch.
- **Console shows `skipping unreadable capture file`:** a queue file that
  isn't valid JSON. It is never deleted automatically. Inspect it with Xcode
  → Window → Devices → App → Download Container → `AppGroup/VoiceCaptures/`.
- **Compile error about `AppIntents` availability:** Part A step 2 was not
  applied to the App target (the file is annotated `@available(iOS 16.0, *)`
  regardless, so this means something else in the target is at the old
  floor — check the *App* target, not the project).
- **Xcode warns the ShareExtension deployment target differs from the App's:**
  step 2 was done on one target only.
