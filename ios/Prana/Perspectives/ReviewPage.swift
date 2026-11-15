// Author: John Grimes

import PranaKit
import SwiftUI

/// The Review page (spec §4 Review): one project at a time from the frozen list of projects due for review, with the
/// review bar, Previous / Next / Mark Reviewed (pinned to the bottom on iPhone) and ⌘[ / ⌘] / ⌘⇧R.
struct ReviewPage: View {
    /// `.review(project:)`.
    let route: Route

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var pages: PagesModel { PagesModel.shared }

    private var current: String? {
        if case .review(let project) = route { project } else { nil }
    }

    private var perspective: Perspective? { store.state.perspectives?.first { $0.id == "review" } }

    /// Whether Review is the page on screen: the phone keeps the Review tab's page mounted under the other tabs.
    private var isShown: Bool {
        if case .review = ShellNavigation.resolve(navigator.route, perspectives: store.state.perspectives) { true } else { false }
    }

    /// What the redirect to the first unreviewed project depends on: picking the Review tab again shows the page
    /// again with the same redirect, which must still be followed.
    private struct RedirectKey: Equatable {
        var shown: Bool
        var route: Route
        var redirect: String??
    }

    var body: some View {
        let items = pages.reviewItems(store)
        let nav = items.map { ReviewNavigation(items: $0, current: current) }
        content(items: items, nav: nav)
            .navigationTitle(nav?.item?.project.task.name ?? perspective?.name ?? "Review")
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // Phones pin the buttons to the bottom with the Quick Entry "+" above them, clear of each other; the
                // "+" stays at the trailing edge when there are no buttons (all projects reviewed).
                if sizeClass == .compact {
                    VStack(alignment: .trailing, spacing: 0) {
                        QuickEntryButton()
                        if let nav, let item = nav.item {
                            ReviewButtons(nav: nav, item: item, markReviewed: { markReviewed(item) })
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                .background(.bar)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .task { await pages.startReview(store) }
            .onChange(of: store.state.review) { pages.absorbDue(store) }
            .onChange(of: store.cleanupCount) { Task { await pages.rebuildAfterCleanUp(store) } }
            .onChange(of: RedirectKey(shown: isShown, route: route, redirect: nav?.redirect), initial: true) { _, key in
                // With no project open (or one no longer listed), open the first unreviewed one, if any; never from
                // under another page.
                if key.shown, let redirect = key.redirect { navigator.navigate(to: .review(project: redirect)) }
            }
            .onDisappear {
                // Leaving Review forgets the list; moving between projects in Review keeps it.
                Task { @MainActor in
                    if !isShown { pages.endReview() }
                }
            }
    }

    @ViewBuilder private func content(items: [ReviewItem]?, nav: ReviewNavigation?) -> some View {
        if let items, let nav {
            if items.isEmpty {
                PageMessage("No projects to review")
            } else if let item = nav.item {
                VStack(spacing: 0) {
                    ReviewBar(nav: nav, item: item, showsButtons: sizeClass != .compact, markReviewed: { markReviewed(item) })
                    Divider()
                    ReviewProjectOutline(project: item.project, perspective: perspective)
                        .id(item.project.id)
                }
            } else if case .some(.some) = nav.redirect {
                // About to open the first unreviewed project.
                PageMessage("Loading…", busy: true)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(.tint)
                    Text("All projects reviewed").font(.title3.weight(.medium))
                    Text("Clean Up clears the reviewed projects from the list.").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("review-done")
            }
        } else {
            PageMessage("Loading…", busy: true)
        }
    }

    private func markReviewed(_ item: ReviewItem) {
        pages.markReviewedAndAdvance(item.project.id, store: store, navigator: navigator)
    }
}

/// Previous / Next / Mark Reviewed, with their keyboard shortcuts.
private struct ReviewButtons: View {
    let nav: ReviewNavigation
    let item: ReviewItem
    let markReviewed: () -> Void

    @Environment(Navigator.self) private var navigator

    var body: some View {
        HStack(spacing: 8) {
            Button("Previous project", systemImage: "chevron.up") {
                if let previous = nav.previous { navigator.navigate(to: .review(project: previous)) }
            }
            .labelStyle(.iconOnly)
            .frame(minWidth: 44, minHeight: 44)
            .disabled(nav.previous == nil)
            .keyboardShortcut("[", modifiers: .command)
            .accessibilityIdentifier("review-previous")
            Button("Next project", systemImage: "chevron.down") {
                if let next = nav.next { navigator.navigate(to: .review(project: next)) }
            }
            .labelStyle(.iconOnly)
            .frame(minWidth: 44, minHeight: 44)
            .disabled(nav.next == nil)
            .keyboardShortcut("]", modifiers: .command)
            .accessibilityIdentifier("review-next")
            Button(action: markReviewed) {
                Label("Mark Reviewed", systemImage: "cup.and.saucer")
                    .frame(maxWidth: .infinity, minHeight: 32)
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut("r", modifiers: [.command, .shift])
            .accessibilityIdentifier("mark-reviewed")
        }
    }
}

/// The bar above the project: progress, reviewed check, last reviewed date, the review schedule and (on iPad) the
/// buttons.
private struct ReviewBar: View {
    let nav: ReviewNavigation
    let item: ReviewItem
    let showsButtons: Bool
    let markReviewed: () -> Void

    @Environment(AppStore.self) private var store
    @State private var showsSchedule = false

    private var lastReviewed: String {
        let settings = store.settings
        guard let w = DateDisplay.toWall(item.project.lastReview, timeZone: settings.timeZone) else { return "" }
        let weekday = DateDisplay.weekdayName(DateDisplay.weekdayOf(year: w.year, month: w.month, day: w.day))
        return "Last reviewed \(weekday) \(DateDisplay.formatDayOnly(w, dateFormat: settings.dateFormat))"
    }

    var body: some View {
        // One row when it fits, else the details stacked with the schedule beside the buttons, else the schedule
        // and buttons on rows of their own (a narrow page, as beside the iPad's sidebar and rail in portrait).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { details; Spacer(minLength: 0); buttons }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 12) { progress; reviewedBadge }
                Text(lastReviewed).foregroundStyle(.secondary)
                HStack { schedule; Spacer(minLength: 0); buttons }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 12) { progress; reviewedBadge }
                Text(lastReviewed).foregroundStyle(.secondary)
                schedule
                buttons
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Review")
        .accessibilityIdentifier("review-bar.\(item.project.id)")
    }

    @ViewBuilder private var details: some View {
        progress
        reviewedBadge
        Text(lastReviewed).foregroundStyle(.secondary)
        schedule
    }

    private var progress: some View {
        Text("\(Text("\(nav.left)").bold().monospacedDigit()) of \(nav.total) left")
            .accessibilityIdentifier("review-progress")
    }

    @ViewBuilder private var reviewedBadge: some View {
        if item.reviewed {
            Label("Reviewed", systemImage: "checkmark").foregroundStyle(.tint)
                .accessibilityIdentifier("review-reviewed")
        }
    }

    private var schedule: some View {
        Button("Review every \(ReviewModel.formatInterval(item.project.reviewInterval))", systemImage: "repeat") {
            showsSchedule = true
        }
        .buttonStyle(.bordered)
        .fixedSize()
        .accessibilityIdentifier("review-schedule")
        .popover(isPresented: $showsSchedule) {
            ReviewScheduleForm(projectId: item.project.id)
                .frame(minWidth: 340, minHeight: 340)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium])
        }
    }

    @ViewBuilder private var buttons: some View {
        if showsButtons { ReviewButtons(nav: nav, item: item, markReviewed: markReviewed) .fixedSize() }
    }
}

/// "Review every" interval and Next review date (`ReviewSchedule` in the web app), edited with instant writes.
private struct ReviewScheduleForm: View {
    let projectId: String

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private var project: Project? { store.state.projects?.first { $0.id == projectId } }

    var body: some View {
        NavigationStack {
            if let project {
                form(project)
            }
        }
    }

    private func form(_ project: Project) -> some View {
        let interval = project.reviewInterval
        let settings = store.settings
        return Form {
            Section("Every") {
                Stepper(value: Binding(get: { interval.steps }, set: { save(ReviewInterval(steps: max(1, $0), unit: interval.unit)) }), in: 1...999) {
                    Text("\(interval.steps)").monospacedDigit()
                }
                .accessibilityIdentifier("review-interval-steps")
                Picker("Unit", selection: Binding(get: { interval.unit }, set: { save(ReviewInterval(steps: interval.steps, unit: $0)) })) {
                    ForEach([IntervalUnit.day, .week, .month, .year], id: \.self) { unit in
                        Text(interval.steps == 1 ? unit.rawValue : unit.rawValue + "s").tag(unit)
                    }
                }
                .accessibilityIdentifier("review-interval-unit")
            }
            Section("Next review") {
                DatePicker(
                    "Next review",
                    selection: Binding(
                        get: { Self.date(project.nextReview, settings: settings) ?? .now },
                        set: { date in
                            let key = Self.dayKey(date)
                            store.patchProject(projectId, ProjectPatch(nextReview: .some(DateDisplay.withDay(project.nextReview, dayKey: key, field: .defer, settings: settings))))
                        }),
                    displayedComponents: .date
                )
                .accessibilityIdentifier("review-next-date")
            }
        }
        .navigationTitle("Review schedule")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }

    private func save(_ interval: ReviewInterval) {
        store.patchProject(projectId, ProjectPatch(reviewInterval: interval))
    }

    /// The calendar day of a stored date, as a local `Date` for the picker.
    private static func date(_ value: String?, settings: Settings) -> Date? {
        guard let value, let w = DateDisplay.toWall(value, timeZone: settings.timeZone) else { return nil }
        return Calendar.current.date(from: DateComponents(year: w.year, month: w.month, day: w.day))
    }

    /// `YYYY-MM-DD` of the picked day.
    private static func dayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return DateDisplay.wallDayKey(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
    }
}

/// The reviewed project's contents (Remaining filter, editable as in Projects).
private struct ReviewProjectOutline: View {
    let project: Project
    let perspective: Perspective?

    @Environment(AppStore.self) private var store
    @Environment(Navigator.self) private var navigator
    @State private var finished = false

    private var key: ContentsKey { ContentsKey(perspectiveId: "review", project: project.id) }

    var body: some View {
        Group {
            if let contents = store.state.contents[key] {
                OutlineView(
                    contents: contents,
                    context: OutlineContext(perspective: perspective, contentsKey: key, reorderMode: navigator.reordering, selection: navigator.selection)
                )
                .overlay {
                    if contents.groups.allSatisfy(\.rows.isEmpty) {
                        PageMessage(PageOptions.emptyText(perspectiveId: "review", contents: contents)).allowsHitTesting(false)
                    }
                }
            } else if finished {
                PageMessage("This project could not be loaded.")
            } else {
                PageMessage("Loading…", busy: true)
            }
        }
        .task {
            await store.load(key)
            finished = true
        }
    }
}
