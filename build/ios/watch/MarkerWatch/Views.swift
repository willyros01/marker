/* Views.swift — the watch screens (Willy's mockup, 30 Oct 2026):
 * no card yet; all golfers on the current hole; one golfer (swipe for the
 * next, turn the crown for other holes); the Out / In / Total summary. */
import SwiftUI

let markerGreen = Color(red: 0.56, green: 0.83, blue: 0.66)
let overColor = Color(red: 1.0, green: 0.77, blue: 0.54)
let underColor = Color(red: 0.56, green: 0.83, blue: 0.66)

func parColor(_ d: Int) -> Color { d > 0 ? overColor : d < 0 ? underColor : .white }

func clock(_ d: Date?) -> String {
  guard let d = d else { return "" }
  let f = DateFormatter()
  f.timeStyle = .short
  f.dateStyle = .none
  return f.string(from: d)
}

@main
struct MarkerWatchApp: App {
  @StateObject private var store = FollowStore()
  var body: some Scene {
    WindowGroup { RootView().environmentObject(store) }
  }
}

struct RootView: View {
  @EnvironmentObject var store: FollowStore
  @Environment(\.scenePhase) private var phase

  var body: some View {
    NavigationStack(path: $store.path) {
      Group {
        if let card = store.card { GroupScreen(card: card) }
        else if let l = store.link { OpeningScreen(link: l) }
        else { WaitingScreen() }
      }
      .navigationDestination(for: Route.self) { r in
        switch r {
        case .player(let p, let k): PlayerPager(start: p, hole: k)
        case .summary(let p): SummaryScreen(p: p)
        }
      }
    }
    .onAppear { store.setActive(true) }
    .onChange(of: phase) { _, p in store.setActive(p == .active) }
  }
}

struct WaitingScreen: View {
  @EnvironmentObject var store: FollowStore
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("No card yet").font(.title3.bold())
        Text("On your iPhone, follow a card and tap Send to my watch.")
          .font(.body).foregroundStyle(.secondary)
        if let m = store.message { Text(m).font(.footnote).foregroundStyle(overColor) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .navigationTitle("The Marker")
  }
}

struct OpeningScreen: View {
  @EnvironmentObject var store: FollowStore
  let link: FollowLink
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text(link.course.isEmpty ? "The card" : link.course).font(.headline).foregroundStyle(markerGreen)
        if let m = store.message {
          Text(m).font(.body).foregroundStyle(overColor)
        } else if store.stale {
          Text("No signal right now. It will try again by itself.").font(.body).foregroundStyle(.secondary)
        } else {
          HStack(spacing: 8) { ProgressView(); Text("Opening…").font(.body) }
        }
        Button("Stop following", role: .destructive) { store.stop() }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .navigationTitle("The Marker")
  }
}

struct StatusLine: View {
  @EnvironmentObject var store: FollowStore
  let card: FollowCard
  var body: some View {
    let when = clock(card.lastAt)
    if card.finished {
      Text("Finished\(when.isEmpty ? "" : " · \(when)")").font(.footnote).foregroundStyle(markerGreen)
    } else if store.stale {
      Text("No signal · \(when.isEmpty ? "earlier" : when)").font(.footnote).foregroundStyle(overColor)
    } else {
      Text(when.isEmpty ? "No scores yet" : "Updated \(when)").font(.footnote).foregroundStyle(.secondary)
    }
  }
}

/* All golfers on the hole being played. Tap a name for that golfer. */
struct GroupScreen: View {
  @EnvironmentObject var store: FollowStore
  let card: FollowCard
  var body: some View {
    let k = card.currentIndex
    let n = card.order[k]
    let h = card.hole(n)
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        Text("Hole \(n) · Par \(h.par)").font(.headline).foregroundStyle(markerGreen)
        StatusLine(card: card)
        HStack { Text("Golfer"); Spacer(); Text("Hole · Total") }
          .font(.footnote).foregroundStyle(.secondary)
        ForEach(card.players.indices, id: \.self) { i in
          let t = card.totals(i)
          NavigationLink(value: Route.player(i, k)) {
            HStack(spacing: 4) {
              Text(card.players[i].name).font(.title3.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
              Spacer(minLength: 4)
              Text(scoreText(card.players[i].scores[n])).font(.title3.weight(.semibold))
              Text("·").foregroundStyle(.secondary)
              Text(t.done > 0 ? toParText(t.toPar) : "–").font(.title3.weight(.semibold))
                .foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
            }
          }
        }
        Text(card.course).font(.footnote).foregroundStyle(.secondary).padding(.top, 4)
        Button("Stop following", role: .destructive) { store.stop() }
      }
    }
    .navigationTitle("The Marker")
  }
}

/* One golfer at a time: swipe for the next golfer, turn the crown for other holes. */
struct PlayerPager: View {
  @EnvironmentObject var store: FollowStore
  @State private var page: Int
  @State private var crown: Double

  init(start: Int, hole: Int) {
    _page = State(initialValue: start)
    _crown = State(initialValue: Double(hole))
  }

  var body: some View {
    if let card = store.card {
      let last = max(card.order.count - 1, 0)
      let k = min(max(Int(crown.rounded()), 0), last)
      TabView(selection: $page) {
        ForEach(card.players.indices, id: \.self) { i in
          PlayerHole(card: card, p: i, k: k).tag(i)
        }
      }
      .tabViewStyle(.page)
      .focusable()
      .digitalCrownRotation($crown, from: 0, through: Double(last), by: 1, sensitivity: .low,
                            isContinuous: false, isHapticFeedbackEnabled: true)
    } else {
      Text("The card is closed.").font(.body)
    }
  }
}

struct PlayerHole: View {
  let card: FollowCard
  let p: Int
  let k: Int
  var body: some View {
    let n = card.order[k]
    let h = card.hole(n)
    let s = card.players[p].scores[n]
    let t = card.totals(p)
    let yd = h.yards.map { " · \($0) yds" } ?? ""
    let nameColor: Color = { if case .strokes(let x)? = s { return parColor(x - h.par) }; return Color.secondary }()
    VStack(spacing: 2) {
      Text(card.players[p].name).font(.headline).foregroundStyle(markerGreen).lineLimit(1)
      Text("Hole \(n) · Par \(h.par)\(yd)")
        .font(.footnote).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(scoreText(s)).font(.system(size: 54, weight: .heavy, design: .rounded))
        Text(scoreName(s, par: h.par)).font(.headline)
          .foregroundStyle(nameColor)
      }
      HStack {
        Text("Thru \(t.done)")
        Spacer()
        Text(t.done > 0 ? "\(t.gross)" : "–")
        Spacer()
        Text(t.done > 0 ? toParText(t.toPar) : "–").foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
      }
      .font(.headline)
      NavigationLink(value: Route.summary(p)) { Text("Summary") }
        .padding(.top, 2)
    }
    .padding(.horizontal, 6)
  }
}

/* Out, In and Total for one golfer. */
struct SummaryScreen: View {
  @EnvironmentObject var store: FollowStore
  let p: Int
  var body: some View {
    if let card = store.card, p < card.players.count {
      let all = card.totals(p)
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          Text(card.players[p].name).font(.headline).foregroundStyle(markerGreen)
          Text("Summary · thru \(all.done)").font(.footnote).foregroundStyle(.secondary)
          if !card.frontNine.isEmpty { SummaryRow(label: "Out", t: card.totals(p, card.frontNine), big: false) }
          if !card.backNine.isEmpty { SummaryRow(label: "In", t: card.totals(p, card.backNine), big: false) }
          SummaryRow(label: "Total", t: all, big: true)
          StatusLine(card: card)
        }
      }
    } else {
      Text("The card is closed.").font(.body)
    }
  }
}

struct SummaryRow: View {
  let label: String
  let t: Totals
  let big: Bool
  var body: some View {
    HStack {
      Text(label).font(.body).foregroundStyle(.secondary).frame(width: 52, alignment: .leading)
      Text(t.done > 0 ? "\(t.gross)" : "—").font(big ? .title2.bold() : .title3.weight(.semibold))
      Spacer()
      Text(t.done > 0 ? toParText(t.toPar) : "—").font(big ? .title2.bold() : .title3.weight(.semibold))
        .foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
    }
  }
}
