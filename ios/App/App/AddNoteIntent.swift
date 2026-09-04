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
//   AddNoteIntent          Siri phrases ("Add a note to Nubble")  → root
//   AddNoteToBubbleIntent  Shortcuts-app action, NO phrases       → a bubble
//
// SPOKEN BUBBLE NAMING WAS ATTEMPTED AND DOES NOT MATCH ON iOS 26. "Add a
// note to Ideas in Nubble" was registered (the Shortcuts tile showed one
// generated entry per bubble, and tapping those filed correctly), the mirror,
// entity query and consumer all verified working, the phone restarted — and
// Siri still routed every spoken bubble phrase to the plain intent. Two
// hypotheses were eliminated: the bubble being an optional parameter (fixed
// by this two-intent split; no change) and a collision with Siri's built-in
// "add a note" grammar ("New note in Ideas in Nubble" also failed). The
// bubble phrases were removed so nobody is told to say something that
// doesn't work. The intent stays as a Shortcuts action: it files correctly,
// and a user can bind their own phrase to it. Full record and the
// verification checklist: ios/VOICE_CAPTURE_SETUP.md, "Spoken bubble
// naming: attempted, does not match". Don't re-add phrases without new
// evidence from that checklist.
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

/// The shared body of both intents: write the capture, return the spoken
/// confirmation.
@available(iOS 16.0, *)
enum VoiceCaptureIntentSupport {
    private static let log = Logger(subsystem: "com.adamlai.flownotes.VoiceCapture", category: "intent")

    /// Filing hints ride along with the capture; the app decides. A real id
    /// files into that bubble if it still exists. A placeholder (a name the
    /// mirror doesn't know) carries only the name, and the app files by name
    /// if such a bubble exists by then, else root.
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

        // Keeps Siri's view of the entity set current. With no parameterised
        // phrases this changes nothing the user can hear; it is left in so
        // re-adding phrases (if a future iOS matches spoken entities) needs
        // no plumbing.
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

/// Filed capture → a chosen bubble. Reached from the Shortcuts app (or a
/// phrase the user binds themselves) — it has no phrases of its own, see the
/// header. The bubble is REQUIRED; a name the mirror doesn't know still
/// resolves (BubbleQuery hands back a placeholder), so the capture is never
/// blocked on filing.
@available(iOS 16.0, *)
struct AddNoteToBubbleIntent: AppIntent {
    static var title: LocalizedStringResource = "Add a Note to a Bubble"
    static var description = IntentDescription(
        "Saves a note in Nubble inside the bubble you choose."
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
/// Plain capture only. AddNoteToBubbleIntent deliberately has NO AppShortcut
/// here — see the file header for why.
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
    }
}
