/* Views.swift — the watch screens (Willy's mockup, 30 Oct 2026):
 * no card yet; all golfers on the current hole; one golfer (swipe for the
 * next, turn the crown for other holes); the Out / In / Total summary. */
import SwiftUI

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
        if store.showWidgets { WidgetGallery() }
        else if let g = store.game { GameScreen(game: g) }
        else if let card = store.card { GroupScreen(card: card) }
        else if let l = store.link { OpeningScreen(link: l) }
        else { WaitingScreen() }
      }
      .navigationDestination(for: Route.self) { r in
        switch r {
        case .player(let p, let k): PlayerPager(start: p, hole: k)
        case .summary(let p): SummaryScreen(p: p)
        case .pad: PadScreen()
        case .gameCard(let i): GameCardScreen(index: i)
        }
      }
    }
    .onAppear { store.setActive(true) }
    .onOpenURL { _ in store.path = [] }   /* a tap on a watch-face box: the group screen */
    .onChange(of: phase) { _, p in store.setActive(p == .active) }
  }
}

struct WaitingScreen: View {
  @EnvironmentObject var store: FollowStore
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        Text("No card yet").font(.title3.bold())
        Text("On your iPhone, follow a card and tap Send to my watch. Or type the follow code here.")
          .font(.body).foregroundStyle(.secondary)
        NavigationLink(value: Route.pad) { Text("Type a follow code") }
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
    if card.posted {
      Text("Posted · following has ended").font(.footnote).foregroundStyle(markerGreen)
    } else if card.finished {
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
      VStack(alignment: .leading, spacing: 5) {
        Text("Hole \(n) · Par \(h.par)").font(.headline).foregroundStyle(markerGreen)
        HStack { Text("Golfer"); Spacer(); Text("Hole · Total") }
          .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 10)
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
            .padding(.vertical, 5).padding(.horizontal, 10)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.2)))
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
        StatusLine(card: card).padding(.top, 2)
        Text(card.course).font(.footnote).foregroundStyle(.secondary)
        NavigationLink(value: Route.pad) { Text("Follow another code") }
        Button("Stop following", role: .destructive) { store.stop() }
      }
      .padding(.horizontal, 4)
    }
  }
}

/* One golfer at a time: swipe for the next golfer. Each golfer's latest
   scored hole is shown and moves on by itself as scores arrive; turning the
   crown looks at other holes, and 30 seconds after the last turn the screen
   goes back to the latest hole (Willy, 30 Oct 2026). */
struct PlayerPager: View {
  @EnvironmentObject var store: FollowStore
  @State private var page: Int
  @State private var crown: Double
  @State private var autoK: Int
  @State private var lookUntil = Date.distantPast

  init(start: Int, hole: Int) {
    _page = State(initialValue: start)
    _crown = State(initialValue: Double(hole))
    _autoK = State(initialValue: hole)
  }

  private func sync(_ k: Int) {
    autoK = k
    crown = Double(k)
  }

  var body: some View {
    if let card = store.card {
      let last = max(card.order.count - 1, 0)
      TimelineView(.periodic(from: .now, by: 5)) { tl in
        let looking = tl.date < lookUntil
        let crownK = min(max(Int(crown.rounded()), 0), last)
        let liveK = card.lastIndex(page)
        TabView(selection: $page) {
          ForEach(card.players.indices, id: \.self) { i in
            PlayerHole(card: card, p: i, k: looking ? crownK : card.lastIndex(i)).tag(i)
          }
        }
        .tabViewStyle(.page)
        .focusable()
        .digitalCrownRotation($crown, from: 0, through: Double(last), by: 1, sensitivity: .low,
                              isContinuous: false, isHapticFeedbackEnabled: true)
        .onChange(of: crown) { _, v in
          if Int(v.rounded()) != autoK { lookUntil = Date().addingTimeInterval(30) }
        }
        .onChange(of: looking) { _, now in if !now { sync(liveK) } }
        .onChange(of: liveK) { _, k in if !looking { sync(k) } }
        .onAppear { if !looking { sync(liveK) }; store.setMe(page) }
        .onChange(of: page) { _, p in store.setMe(p) }
      }
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
        .padding(.horizontal, 6)
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

/* The build check only: the two watch-face boxes, as the widgets draw them. */
struct WidgetGallery: View {
  @EnvironmentObject var store: FollowStore
  var body: some View {
    ScrollView {
      VStack(spacing: 10) {
        MineBox(card: store.card, me: 1)
          .padding(8).background(RoundedRectangle(cornerRadius: 14).stroke(Color.gray, lineWidth: 1))
        GroupBox(card: store.card)
          .padding(8).background(RoundedRectangle(cornerRadius: 14).stroke(Color.gray, lineWidth: 1))
        MineRound(card: store.card, me: 1).frame(width: 80, height: 80)
      }
    }
  }
}

/* ---------------- 1.1.0: a whole game, and typing a code on the watch ---------------- */

/* The game's leaderboard (Willy, 31 Oct 2026): one line per golfer with place,
   first name, gross to par and holes played; tap a line for that card. Final:
   gross, then net. */
struct GameScreen: View {
  @EnvironmentObject var store: FollowStore
  let game: GameBoard
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 5) {
        Text(game.name.isEmpty ? "The game" : game.name).font(.headline).foregroundStyle(markerGreen).lineLimit(2)
        if game.cards.isEmpty {
          Text("No card is live yet. Cards show up as their scorers tee off.").font(.body).foregroundStyle(.secondary)
        } else if game.isFinal {
          Text("Final · gross").font(.footnote.weight(.bold)).foregroundStyle(.secondary)
          ForEach(game.gross) { r in GameLine(row: r, value: "\(r.gross)", color: .white) }
          if !game.net.isEmpty {
            Text("Net").font(.footnote.weight(.bold)).foregroundStyle(.secondary).padding(.top, 4)
            ForEach(game.net) { r in GameLine(row: r, value: "\(r.net ?? 0)", color: .white) }
          }
        } else {
          HStack { Text("#"); Text("Golfer"); Spacer(); Text("Par · Thru") }
            .font(.footnote).foregroundStyle(.secondary).padding(.horizontal, 8)
          ForEach(game.live) { r in
            GameLine(row: r, value: r.thru > 0 ? toParText(r.toPar) : "–", color: r.thru > 0 ? parColor(r.toPar) : .secondary)
          }
        }
        GameStatus(game: game).padding(.top, 2)
        NavigationLink(value: Route.pad) { Text("Follow another code") }
        Button("Stop following", role: .destructive) { store.stop() }
      }
      .padding(.horizontal, 4)
    }
  }
}

struct GameLine: View {
  let row: GameRow
  let value: String
  let color: Color
  var body: some View {
    NavigationLink(value: Route.gameCard(row.card)) {
      HStack(spacing: 4) {
        Text(row.place).font(.footnote.weight(.bold)).foregroundStyle(.secondary).frame(width: 26, alignment: .leading)
        Text(firstName(row.name)).font(.title3.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.6)
        Spacer(minLength: 2)
        Text(value).font(.title3.weight(.bold)).foregroundStyle(color)
        Text(row.complete ? "F" : row.thru > 0 ? "\(row.thru)" : "").font(.footnote).foregroundStyle(.secondary).frame(width: 18, alignment: .trailing)
      }
      .padding(.vertical, 4).padding(.horizontal, 8)
      .frame(maxWidth: .infinity)
      .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.2)))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

struct GameStatus: View {
  @EnvironmentObject var store: FollowStore
  let game: GameBoard
  var body: some View {
    let when = clock(game.lastAt)
    if game.isFinal {
      Text("Every card is finished").font(.footnote).foregroundStyle(markerGreen)
    } else if store.stale {
      Text("No signal · \(when.isEmpty ? "earlier" : when)").font(.footnote).foregroundStyle(overColor)
    } else {
      Text(when.isEmpty ? "No scores yet" : "Updated \(when)").font(.footnote).foregroundStyle(.secondary)
    }
  }
}

/* One card of the game: everyone on that card, hole being played and total. */
struct GameCardScreen: View {
  @EnvironmentObject var store: FollowStore
  let index: Int
  var body: some View {
    if let g = store.game, index >= 0, index < g.cards.count {
      let card = g.cards[index]
      let n = card.order[card.currentIndex]
      ScrollView {
        VStack(alignment: .leading, spacing: 5) {
          Text("Hole \(n) · Par \(card.hole(n).par)").font(.headline).foregroundStyle(markerGreen)
          ForEach(card.players.indices, id: \.self) { i in
            let t = card.totals(i)
            HStack(spacing: 4) {
              Text(card.players[i].name).font(.title3.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.6)
              Spacer(minLength: 4)
              Text(scoreText(card.players[i].scores[n])).font(.title3.weight(.semibold))
              Text("·").foregroundStyle(.secondary)
              Text(t.done > 0 ? toParText(t.toPar) : "–").font(.title3.weight(.semibold))
                .foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
            }
            .padding(.vertical, 5).padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.2)))
          }
          Text(card.posted ? "Posted" : card.finished ? "Finished" : card.byCaddie ? "Scored by a caddie" : "Live")
            .font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
      }
    } else {
      Text("The card is closed.").font(.body)
    }
  }
}

/* Typing a six-number follow code on the watch (Willy, 31 Oct 2026). */
struct PadScreen: View {
  @EnvironmentObject var store: FollowStore
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?
  private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"]
  var body: some View {
    VStack(spacing: 3) {
      Text(code.isEmpty ? "Follow code" : spaced(code))
        .font(.system(size: code.isEmpty ? 15 : 22, weight: .heavy, design: .rounded))
        .foregroundStyle(code.isEmpty ? .secondary : .primary)
      if let e = error { Text(e).font(.system(size: 11)).foregroundStyle(overColor).lineLimit(2).minimumScaleFactor(0.7) }
      if busy { ProgressView() }
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3), spacing: 3) {
        ForEach(keys, id: \.self) { k in
          Button(action: { tap(k) }) {
            Text(k).font(.system(size: 18, weight: .bold, design: .rounded))
              .frame(maxWidth: .infinity, minHeight: 28)
              .foregroundStyle(k == "✓" ? (code.count == 6 ? Color.black : Color.secondary) : Color.white)
              .background(RoundedRectangle(cornerRadius: 8).fill(k == "✓" ? (code.count == 6 ? markerGreen : Color(white: 0.2)) : Color(white: 0.25)))
          }
          .buttonStyle(.plain)
          .disabled(busy || (k == "✓" && code.count != 6))
          .accessibilityLabel(k == "⌫" ? "Delete" : k == "✓" ? "Follow" : k)
        }
      }
    }
    .padding(.horizontal, 2)
  }

  private func spaced(_ s: String) -> String {
    s.count > 3 ? String(s.prefix(3)) + " " + String(s.dropFirst(3)) : s
  }

  private func tap(_ k: String) {
    error = nil
    if k == "⌫" { if !code.isEmpty { code.removeLast() }; return }
    if k == "✓" {
      busy = true
      Task { @MainActor in
        let why = await store.follow(code: code)
        busy = false
        if let w = why { error = w } else { code = "" }
      }
      return
    }
    if code.count < 6 { code += k }
  }
}
