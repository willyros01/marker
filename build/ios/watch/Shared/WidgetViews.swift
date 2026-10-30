/* WidgetViews.swift — the two watch-face boxes (Willy's mockup, 30 Oct 2026),
 * shared by the widgets and by the app's build-check screen.
 *   MineBox:  THE MARKER · updated time / golfer · hole / score · to par
 *   GroupBox: HOLE n · updated time / all golfers, two per line */
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

struct NoCardBox: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("THE MARKER").font(.caption2.weight(.bold)).foregroundStyle(markerGreen)
      Text("No card yet").font(.headline)
      Text("Send one from the iPhone").font(.caption2).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct MineBox: View {
  let card: FollowCard?
  let me: Int
  var body: some View {
    if let c = card, !c.players.isEmpty {
      let p = (me >= 0 && me < c.players.count) ? me : 0
      let k = c.lastIndex(p)
      let n = c.order[k]
      let s = c.players[p].scores[n]
      let t = c.totals(p)
      VStack(alignment: .leading, spacing: 1) {
        HStack {
          Text(c.posted ? "POSTED" : "THE MARKER").font(.caption2.weight(.bold)).foregroundStyle(markerGreen)
          Spacer()
          Text(clock(c.lastAt)).font(.caption2).foregroundStyle(.secondary)
        }
        Text("\(firstName(c.players[p].name)) · Hole \(n)").font(.headline).lineLimit(1).minimumScaleFactor(0.7)
        HStack(spacing: 6) {
          Text(scoreText(s)).font(.title3.weight(.bold))
          Text("·").foregroundStyle(.secondary)
          Text(t.done > 0 ? toParText(t.toPar) : "–").font(.title3.weight(.bold))
            .foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
          Spacer(minLength: 0)
          Text("Thru \(t.done)").font(.caption2).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      NoCardBox()
    }
  }
}

struct GroupBox: View {
  let card: FollowCard?
  var body: some View {
    if let c = card, !c.players.isEmpty {
      let k = c.currentIndex
      let n = c.order[k]
      let rows = stride(from: 0, to: c.players.count, by: 2).map { Array($0..<min($0 + 2, c.players.count)) }
      VStack(alignment: .leading, spacing: 1) {
        HStack {
          Text(c.posted ? "POSTED · HOLE \(n)" : "HOLE \(n) · PAR \(c.hole(n).par)").font(.caption2.weight(.bold)).foregroundStyle(markerGreen)
          Spacer()
          Text(clock(c.lastAt)).font(.caption2).foregroundStyle(.secondary)
        }
        ForEach(rows, id: \.self) { row in
          HStack(spacing: 8) {
            ForEach(row, id: \.self) { i in
              let t = c.totals(i)
              HStack(spacing: 3) {
                Text(firstName(c.players[i].name)).lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 2)
                Text(scoreText(c.players[i].scores[n]))
                Text(t.done > 0 ? toParText(t.toPar) : "–").foregroundStyle(t.done > 0 ? parColor(t.toPar) : .secondary)
              }
              .font(.system(size: 15, weight: .semibold))
              .frame(maxWidth: .infinity)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      NoCardBox()
    }
  }
}

/* The round "my score" (0.9.8): for round slots such as the X-Large face's.
   The hole on top, the score to par large. */
struct MineRound: View {
  let card: FollowCard?
  let me: Int
  var body: some View {
    ZStack {
      Circle().fill(Color(white: 0.16))
      if let c = card, !c.players.isEmpty {
        let p = (me >= 0 && me < c.players.count) ? me : 0
        let n = c.order[c.lastIndex(p)]
        let t = c.totals(p)
        VStack(spacing: -1) {
          Text("H\(n)").font(.system(size: 13, weight: .bold)).foregroundStyle(markerGreen)
          Text(t.done > 0 ? toParText(t.toPar) : "–").font(.system(size: 24, weight: .heavy, design: .rounded))
            .foregroundStyle(t.done > 0 ? parColor(t.toPar) : .white)
            .minimumScaleFactor(0.5).lineLimit(1)
        }
        .padding(4)
      } else {
        Text("MKR").font(.system(size: 13, weight: .bold)).foregroundStyle(markerGreen)
      }
    }
  }
}
