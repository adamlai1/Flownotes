import AppIntents
import Foundation
import os.log

// ── Siri / Shortcuts voice capture ──────────────────────────────────────────
//
// Two App Intents, one job: drop what the user said into the App Group
// capture queue (VoiceCaptureStore, defined in SceneDelegate.swift). The web
// layer (src/lib/voiceCapture.js) turns queued captures into notes the next
// time it is ready to.
//
//   AddNoteIntent          "Add a note to Nubble"           → root
//   AddNoteToBubbleIntent  "Add a note to Ideas in Nubble"  → that bubble
//
// Why two intents rather than one with an optional bubble: a phrase can only
// carry a parameter Siri can enumerate ahead of time, and an OPTIONAL
// parameter in a phrase is not reliably registered by the metadata
// processor — the bubble phrases can silently fail to exist while everything
// else works. With the bubble on its own intent it is required there and
// absent here, so the plain phrase can never prompt "Which bubble?" and the
// filed phrase always has a bubble to file into.
//
// Both are compiled into the App target itself (NOT an extension). With
// openAppWhenRun = false, iOS runs perform() in the background: if Nubble is
// not running it is launched WITHOUT a scene — no window, no WKWebView, no
// React — writes the capture, and suspends again. If Nubble is already
// running, perform() runs inside that process and VoiceCaptureStore's
// notification lets VoiceCapturePlugin hand the capture to the web layer at
// once. Either way the user never leaves Siri.
//
// This file sits beside SceneDelegate.swift but is a compile source only once
// ios/VOICE_CAPTURE_SETUP.md (Part B) adds it — and BubbleEntity.swift — to the
// App target (v1.3). Until then main builds exactly as before. THIS is the
// compiled copy: there is no other.
//
// Logging: filter Console.app on subsystem com.adamlai.flownotes.VoiceCapture.
// Only lengths and ids are logged, never the spoken text.

/// The shared body of both intents: write the capture, refresh Siri's bubble
/// phrases, return the spoken confirmation.
@available(iOS 16.0, *)
enum VoiceCaptureIntentSupport {
    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "intent")

    /// Filing hints ride along with the capture; the app decides. A real id
    /// files into that bubble if it still exists. A placeholder (a name Siri
    /// couldn't match against the mirror) carries only the name, and the app
    /// files by name if such a bubble exists by then, else root.
    static func capture(_ text: String, bubble: BubbleEntity?) throws -> IntentDialog {
        let bubbleId: String? = (bubble?.isPlaceholder ?? true) ? nil : bubble?.id
        let bubbleName: String? = bubble?.name
        do {
            let id = try VoiceCaptureStore.append(text, bubbleId: bubbleId, bubbleName: bubbleName)
            log.notice("intent stored capture \(id, privacy: .public) (\(text.count, privacy: .public) chars, bubble: \(bubbleId == nil ? (bubbleName == nil ? "none" : "by-name") : "by-id", privacy: .public))")
        } catch {
            // Siri reads errorDescription aloud, so VoiceCaptureError's copy
            // must make sense spoken.
            log.error("intent failed to store capture: \(String(describing: error), privacy: .public)")
            throw error
        }

        // Self-healing phrase refresh. The app also asks Siri to re-read the
        // bubble list after every mirror write and at launch, but those go
        // through a by-class-name dispatch (SceneDelegate.swift can't name
        // this file's types). This call is direct and cannot be a silent
        // no-op: one plain "add a note to Nubble" after a launch is enough
        // to make every mirrored bubble sayable.
        NubbleShortcuts.updateAppShortcutParameters()

        // The spoken confirmation is the user's proof the capture landed —
        // and where. Its ABSENCE is the tell that Siri never ran an intent.
        if let bubble = bubble, !bubble.isPlaceholder {
            return "Added to \(bubble.name)"
        }
        return "Added to Nubble"
    }
}

/// Plain capture → root. No bubble parameter at all, so Siri can never ask
/// for one on this phrase.
@available(iOS 16.0, *)
struct AddNoteIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a Note"
    static var description = IntentDescription(
        "Saves what you say as a new note in Nubble, at the top level of your current project."
    )

    // Capture only. Never bring the app forward: speaking a note should feel
    // like it landed the instant Siri says so.
    static var openAppWhenRun: Bool = false

    // When the phrase carries no text ("Add a note to Nubble"), Siri asks this
    // and takes the spoken answer — that is the voice-capture path.
    @Parameter(title: "Note", requestValueDialog: "What's the note?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to Nubble")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What's the note?")
        }
        let dialog = try VoiceCaptureIntentSupport.capture(trimmed, bubble: nil)
        return .result(dialog: dialog)
    }
}

/// Filed capture → a named bubble. The bubble is REQUIRED on this intent; it
/// comes from the phrase itself, or — if this intent is somehow reached
/// without one — from a "Which bubble?" prompt over the mirrored list. A
/// name the mirror doesn't know still resolves (BubbleQuery hands back a
/// placeholder), so the capture is never blocked on filing.
@available(iOS 16.0, *)
struct AddNoteToBubbleIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a Note to a Bubble"
    static var description = IntentDescription(
        "Saves what you say as a new note in Nubble, inside the bubble you name."
    )

    static var openAppWhenRun: Bool = false

    @Parameter(title: "Note", requestValueDialog: "What's the note?")
    var text: String

    @Parameter(title: "Bubble", requestValueDialog: "Which bubble?")
    var bubble: BubbleEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$text) to \(\.$bubble)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $text.needsValueError("What's the note?")
        }
        let dialog = try VoiceCaptureIntentSupport.capture(trimmed, bubble: bubble)
        return .result(dialog: dialog)
    }
}

/// The phrases Siri listens for, available the moment the app is installed —
/// no Shortcuts setup, no first launch. `.applicationName` matches the
/// display name ("Nubble") AND every entry in Info.plist's
/// INAlternativeAppNames (also "Nubble", so the phrase survives a display
/// name change).
///
/// The bubble phrases are generated per mirrored bubble: Siri precomputes
/// one variant for each entity `BubbleQuery.suggestedEntities()` returns, at
/// install and on every `updateAppShortcutParameters()` — which is why the
/// mirror is filtered and capped, and why that call is made from three
/// places (launch, mirror write, every intent run).
@available(iOS 16.0, *)
struct NubbleShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddNoteIntent(),
            phrases: [
                "Add a note to \(.applicationName)",
                "Add a note in \(.applicationName)",
                "New note in \(.applicationName)",
                "Take a note in \(.applicationName)",
                "Note in \(.applicationName)",
            ],
            shortTitle: "Add a Note",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: AddNoteToBubbleIntent(),
            phrases: [
                "Add a note to \(\.$bubble) in \(.applicationName)",
                "Add a note in \(\.$bubble) in \(.applicationName)",
                "New note in \(\.$bubble) in \(.applicationName)",
                "Add a \(.applicationName) note to \(\.$bubble)",
                "Note in \(\.$bubble) in \(.applicationName)",
            ],
            shortTitle: "Add a Note to a Bubble",
            systemImageName: "mic.badge.plus"
        )
    }
}
