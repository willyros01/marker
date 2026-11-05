/* MarkerWidgets.swift — The Marker on the watch face and in the Smart Stack
 * (Willy, 30 Oct 2026). Two boxes: "my score" (the golfer last opened on the
 * watch) and "the group" (everyone on the current hole). watchOS decides how
 * often they refresh (about every 10 to 20 minutes); the app refreshes them
 * at once whenever it reads new scores. A tap opens the group screen. */
import WidgetKit
import SwiftUI

struct MarkerEntry: TimelineEntry {
  let date: Date
  let card: FollowCard?
  let me: Int
  var game: GameBoard? = nil
}

struct MarkerProvider: TimelineProvider {
  func placeholder(in context: Context) -> MarkerEntry { MarkerEntry(date: Date(), card: FollowCard.sample, me: 1) }

  func getSnapshot(in context: Context, completion: @escaping (MarkerEntry) -> Void) {
    completion(context.isPreview ? placeholder(in: context) : now())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<MarkerEntry>) -> Void) {
    Task {
      if let l = Shared.loadLink(), !(Shared.loadCard()?.posted ?? false) {
        if let r = try? await FollowNet.view(l), GameBoard.parse(r.0) != nil || FollowCard.parse(r.0) != nil { Shared.saveCardData(r.1) }
      }
      completion(Timeline(entries: [now()], policy: .after(Date().addingTimeInterval(10 * 60))))
    }
  }

  private func now() -> MarkerEntry {
    let on = Shared.loadLink() != nil
    return MarkerEntry(date: Date(), card: on ? Shared.loadCard() : nil, me: Shared.me, game: on ? Shared.loadGame() : nil)
  }
}

struct MyScoreWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "MarkerMine", provider: MarkerProvider()) { e in
      MineView(entry: e)
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "themarker://group"))
    }
    .configurationDisplayName("The Marker: my score")
    .description("The golfer you last opened: hole, score and score to par.")
    .supportedFamilies([.accessoryRectangular, .accessoryCircular])
  }
}

/* The wide box, or the round one for round slots (0.9.8). */
struct MineView: View {
  @Environment(\.widgetFamily) var family
  let entry: MarkerEntry
  var body: some View {
    if let g = entry.game {
      if family == .accessoryCircular { GameRound(game: g) } else { GameBox(game: g) }
    } else if family == .accessoryCircular { MineRound(card: entry.card, me: entry.me) }
    else { MineBox(card: entry.card, me: entry.me) }
  }
}

struct GroupWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "MarkerGroup", provider: MarkerProvider()) { e in
      GroupView(entry: e)
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "themarker://group"))
    }
    .configurationDisplayName("The Marker: the group")
    .description("Everyone on the current hole: score and score to par.")
    .supportedFamilies([.accessoryRectangular])
  }
}

/* The group box, or the game's leaderboard when a game is followed (1.1.0). */
struct GroupView: View {
  let entry: MarkerEntry
  var body: some View {
    if let g = entry.game { GameBox(game: g) } else { GroupBox(card: entry.card) }
  }
}

@main
struct MarkerWidgetBundle: WidgetBundle {
  var body: some Widget {
    MyScoreWidget()
    GroupWidget()
  }
}
