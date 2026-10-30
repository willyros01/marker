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
}

struct MarkerProvider: TimelineProvider {
  func placeholder(in context: Context) -> MarkerEntry { MarkerEntry(date: Date(), card: FollowCard.sample, me: 1) }

  func getSnapshot(in context: Context, completion: @escaping (MarkerEntry) -> Void) {
    completion(context.isPreview ? placeholder(in: context) : now())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<MarkerEntry>) -> Void) {
    Task {
      if let l = Shared.loadLink(), !(Shared.loadCard()?.posted ?? false) {
        if let r = try? await FollowNet.view(l), FollowCard.parse(r.0) != nil { Shared.saveCardData(r.1) }
      }
      completion(Timeline(entries: [now()], policy: .after(Date().addingTimeInterval(10 * 60))))
    }
  }

  private func now() -> MarkerEntry {
    MarkerEntry(date: Date(), card: Shared.loadLink() != nil ? Shared.loadCard() : nil, me: Shared.me)
  }
}

struct MyScoreWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "MarkerMine", provider: MarkerProvider()) { e in
      MineBox(card: e.card, me: e.me)
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "themarker://group"))
    }
    .configurationDisplayName("The Marker: my score")
    .description("The golfer you last opened: hole, score and score to par.")
    .supportedFamilies([.accessoryRectangular])
  }
}

struct GroupWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "MarkerGroup", provider: MarkerProvider()) { e in
      GroupBox(card: e.card)
        .containerBackground(for: .widget) { Color.black }
        .widgetURL(URL(string: "themarker://group"))
    }
    .configurationDisplayName("The Marker: the group")
    .description("Everyone on the current hole: score and score to par.")
    .supportedFamilies([.accessoryRectangular])
  }
}

@main
struct MarkerWidgetBundle: WidgetBundle {
  var body: some Widget {
    MyScoreWidget()
    GroupWidget()
  }
}
