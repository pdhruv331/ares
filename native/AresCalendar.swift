// ares-calendar: ARES's EventKit helper (docs/panels-prompt.md, sections 3 and 4). Reads and writes the Mac's calendars
// (which hold the user's Google Calendar once it's added under Internet Accounts) and Reminders, locally and for free,
// and reports every change the moment macOS sees it (EKEventStoreChanged), so the panel follows edits made in ARES,
// in Calendar.app, on the phone or on the web.
//
// Launched like ARES Vision: as a real app through LaunchServices (`open -a "ARES Calendar.app" --args --serve <socket>`),
// so macOS grants Calendars / Reminders to something it can name ("ARES Calendar"), and the grant is the same for the
// installed app and a dev run. It connects back to ARES's UNIX socket and talks JSON lines; it exits when ARES hangs up.
//
// Commands (one JSON object per line):
//   {"cmd":"auth","reminders":bool}           ask for full access (the prompt appears on first use) → permission
//   {"cmd":"status"}                           → permission (no prompt)
//   {"cmd":"calendars"}                        → calendars
//   {"cmd":"events","from":ms,"to":ms,"id"}    → events in the range (every calendar)
//   {"cmd":"add","title","start","end","allDay","location","notes","calendar","id"}      → done {event}
//   {"cmd":"update","id","occurrence":ms,"title","start","end","location","notes"}    → done {event}
//   {"cmd":"delete","id","occurrence":ms}                                               → done
//   {"cmd":"refresh"}                          ask macOS to sync its sources (Google changes arrive when it does)
//   {"cmd":"reminders","id"}                   open reminders, every list → reminders
//   {"cmd":"reminder-add","title","due":ms,"list","notes","id"}   → done {reminder}
//   {"cmd":"reminder-complete","id","undo":bool}                   → done
//   {"cmd":"reminder-update","id","title","due","notes"}           → done
//   {"cmd":"quit"}
// Events out: {"type":"ready"} {"type":"permission","events":"…","reminders":"…"} {"type":"changed"} (debounced)
//   {"type":"error","id","message"}
// Keychain (a direct run, no socket; the secret goes through stdin/stdout, never argv):
//   ares-calendar keychain get <service>      prints the secret (exit 1 when there's none)
//   ares-calendar keychain set <service>      reads the secret from stdin
//   ares-calendar keychain delete <service>
import EventKit
import Foundation
import Security

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments

// ---- Keychain --------------------------------------------------------------------------------------------------------
func keychain(_ op: String, _ service: String) -> Int32 {
  let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ARES \(service)", kSecAttrAccount as String: "ares"]
  switch op {
  case "get":
    var q = base; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    guard st == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return 1 }
    FileHandle.standardOutput.write(Data(s.utf8))
    return 0
  case "set":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    var secret = String(data: data, encoding: .utf8) ?? ""
    while secret.hasSuffix("\n") { secret.removeLast() }
    guard !secret.isEmpty else { FileHandle.standardError.write(Data("empty secret\n".utf8)); return 2 }
    let payload = Data(secret.utf8)
    var st = SecItemUpdate(base as CFDictionary, [kSecValueData as String: payload] as CFDictionary)
    if st == errSecItemNotFound {
      var add = base; add[kSecValueData as String] = payload; add[kSecAttrLabel as String] = "ARES \(service)"
      st = SecItemAdd(add as CFDictionary, nil)
    }
    if st != errSecSuccess { FileHandle.standardError.write(Data("keychain error \(st)\n".utf8)); return 3 }
    return 0
  case "delete":
    let st = SecItemDelete(base as CFDictionary)
    return st == errSecSuccess || st == errSecItemNotFound ? 0 : 3
  default:
    FileHandle.standardError.write(Data("keychain get|set|delete <service>\n".utf8)); return 2
  }
}
if args.count >= 4 && args[1] == "keychain" { exit(keychain(args[2], args[3])) }

// ---- Output ----------------------------------------------------------------------------------------------------------
var outFD: Int32 = 1
let outLock = NSLock()
func emitLine(_ s: String) {
  outLock.lock(); defer { outLock.unlock() }
  let data = Array((s + "\n").utf8)
  var off = 0
  data.withUnsafeBytes { p in
    while off < data.count {
      let n = write(outFD, p.baseAddress! + off, data.count - off)
      if n <= 0 { if outFD != 1 { exit(0) }; return } // ARES hung up
      off += Int(n)
    }
  }
}
func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) else { return }
  emitLine(s)
}
func fail(_ id: Any?, _ message: String) { emit(["type": "error", "id": id ?? NSNull(), "message": message]) }

// ---- EventKit --------------------------------------------------------------------------------------------------------
let store = EKEventStore()
let ms = { (d: Date?) -> Any in d.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull() }
let date = { (v: Any?) -> Date? in (v as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) } }
func statusWord(_ s: EKAuthorizationStatus) -> String {
  switch s {
  case .fullAccess, .authorized: return "authorized"
  case .writeOnly: return "writeOnly"
  case .denied: return "denied"
  case .restricted: return "restricted"
  default: return "notDetermined"
  }
}
func permission() -> [String: Any] {
  ["type": "permission", "events": statusWord(EKEventStore.authorizationStatus(for: .event)), "reminders": statusWord(EKEventStore.authorizationStatus(for: .reminder))]
}
func hex(_ c: CGColor?) -> String {
  guard let c = c, let rgb = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil), let k = rgb.components, k.count >= 3 else { return "" }
  return String(format: "#%02x%02x%02x", Int(k[0] * 255), Int(k[1] * 255), Int(k[2] * 255))
}
func calendarJSON(_ c: EKCalendar) -> [String: Any] {
  ["id": c.calendarIdentifier, "title": c.title, "source": c.source?.title ?? "", "sourceType": c.source.map { "\($0.sourceType.rawValue)" } ?? "",
   "color": hex(c.cgColor), "allowsModify": c.allowsContentModifications, "type": c.type.rawValue, "subscribed": c.isSubscribed]
}
func eventJSON(_ e: EKEvent) -> [String: Any] {
  var url = e.url?.absoluteString ?? ""
  let notes = e.notes ?? ""
  if url.isEmpty, let m = notes.range(of: #"https://[^\s<>"]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|facetime\.apple\.com)[^\s<>"]*"#, options: .regularExpression) { url = String(notes[m]) }
  if url.isEmpty, let loc = e.location, loc.hasPrefix("https://") { url = loc }
  let attendees = (e.attendees ?? []).filter { !$0.isCurrentUser }.prefix(8).map { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
  return ["id": e.eventIdentifier ?? "", "title": e.title ?? "", "start": ms(e.startDate), "end": ms(e.endDate), "allDay": e.isAllDay,
          "location": e.location ?? "", "notes": String(notes.prefix(600)), "link": url, "attendees": Array(attendees),
          "calendar": e.calendar?.title ?? "", "color": hex(e.calendar?.cgColor), "recurring": e.hasRecurrenceRules || e.isDetached,
          "status": e.status.rawValue, "organizer": e.organizer?.name ?? "", "declined": (e.attendees ?? []).contains { $0.isCurrentUser && $0.participantStatus == .declined }]
}
func reminderJSON(_ r: EKReminder) -> [String: Any] {
  let due = r.dueDateComponents.flatMap { Calendar.current.date(from: $0) }
  return ["id": r.calendarItemIdentifier, "title": r.title ?? "", "due": ms(due), "allDay": r.dueDateComponents?.hour == nil, "list": r.calendar?.title ?? "",
          "listId": r.calendar?.calendarIdentifier ?? "", "notes": String((r.notes ?? "").prefix(400)), "priority": r.priority, "completed": r.isCompleted]
}
/** The event with this identifier, the instance at `occurrence` when it's a recurring one. */
func findEvent(_ id: String, occurrence: Date?) -> EKEvent? {
  guard let first = store.event(withIdentifier: id) else { return nil }
  guard let at = occurrence, first.hasRecurrenceRules || first.isDetached else { return first }
  let pred = store.predicateForEvents(withStart: at.addingTimeInterval(-1), end: at.addingTimeInterval(1), calendars: nil)
  return store.events(matching: pred).first { $0.calendarItemIdentifier == first.calendarItemIdentifier && abs($0.startDate.timeIntervalSince(at)) < 60 } ?? first
}
func pickCalendar(_ name: Any?, for kind: EKEntityType) -> EKCalendar? {
  let all = store.calendars(for: kind).filter { $0.allowsContentModifications }
  if let n = (name as? String)?.lowercased(), !n.isEmpty, let c = all.first(where: { $0.title.lowercased() == n }) ?? all.first(where: { $0.title.lowercased().contains(n) }) { return c }
  return (kind == .event ? store.defaultCalendarForNewEvents : store.defaultCalendarForNewReminders()) ?? all.first
}

var changeTimer: Timer?
func handle(_ m: [String: Any]) {
  let cmd = m["cmd"] as? String ?? ""
  let id = m["id"]
  switch cmd {
  case "status": emit(permission())
  case "auth":
    let wantReminders = m["reminders"] as? Bool ?? false
    let done = { DispatchQueue.main.async { emit(permission()) } }
    store.requestFullAccessToEvents { _, _ in
      if wantReminders { store.requestFullAccessToReminders { _, _ in done() } } else { done() }
    }
  case "calendars":
    emit(["type": "calendars", "id": id ?? NSNull(), "list": store.calendars(for: .event).map(calendarJSON), "reminderLists": store.calendars(for: .reminder).map(calendarJSON)])
  case "events":
    guard let from = date(m["from"]), let to = date(m["to"]) else { return fail(id, "from/to missing") }
    let pred = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    let list = store.events(matching: pred).sorted { $0.startDate < $1.startDate }.map(eventJSON)
    emit(["type": "events", "id": id ?? NSNull(), "from": ms(from), "to": ms(to), "list": list])
  case "add":
    guard let title = m["title"] as? String, !title.isEmpty, let start = date(m["start"]) else { return fail(id, "title/start missing") }
    let e = EKEvent(eventStore: store)
    e.title = title
    e.startDate = start
    e.isAllDay = m["allDay"] as? Bool ?? false
    e.endDate = date(m["end"]) ?? start.addingTimeInterval(e.isAllDay ? 86_400 : 3_600)
    if let l = m["location"] as? String, !l.isEmpty { e.location = l }
    if let n = m["notes"] as? String, !n.isEmpty { e.notes = n }
    guard let cal = pickCalendar(m["calendar"], for: .event) else { return fail(id, "no writable calendar") }
    e.calendar = cal
    do { try store.save(e, span: .thisEvent, commit: true); emit(["type": "done", "id": id ?? NSNull(), "event": eventJSON(e)]) } catch { fail(id, error.localizedDescription) }
  case "update":
    guard let eid = m["eventId"] as? String ?? m["event"] as? String, let e = findEvent(eid, occurrence: date(m["occurrence"])) else { return fail(id, "no such event") }
    if let t = m["title"] as? String, !t.isEmpty { e.title = t }
    if let s = date(m["start"]) { let len = e.endDate.timeIntervalSince(e.startDate); e.startDate = s; e.endDate = date(m["end"]) ?? s.addingTimeInterval(len) }
    else if let en = date(m["end"]) { e.endDate = en }
    if let l = m["location"] as? String { e.location = l }
    if let n = m["notes"] as? String { e.notes = n }
    if let a = m["allDay"] as? Bool { e.isAllDay = a }
    let span: EKSpan = (m["all"] as? Bool ?? false) ? .futureEvents : .thisEvent
    do { try store.save(e, span: span, commit: true); emit(["type": "done", "id": id ?? NSNull(), "event": eventJSON(e)]) } catch { fail(id, error.localizedDescription) }
  case "delete":
    guard let eid = m["eventId"] as? String ?? m["event"] as? String, let e = findEvent(eid, occurrence: date(m["occurrence"])) else { return fail(id, "no such event") }
    let span: EKSpan = (m["all"] as? Bool ?? false) ? .futureEvents : .thisEvent
    do { try store.remove(e, span: span, commit: true); emit(["type": "done", "id": id ?? NSNull()]) } catch { fail(id, error.localizedDescription) }
  case "refresh":
    store.refreshSourcesIfNecessary()
    emit(["type": "done", "id": id ?? NSNull()])
  case "reminders":
    let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
    store.fetchReminders(matching: pred) { list in
      let out = (list ?? []).map(reminderJSON)
      DispatchQueue.main.async { emit(["type": "reminders", "id": id ?? NSNull(), "list": out, "lists": store.calendars(for: .reminder).map(calendarJSON)]) }
    }
  case "reminder-add":
    guard let title = m["title"] as? String, !title.isEmpty else { return fail(id, "title missing") }
    let r = EKReminder(eventStore: store)
    r.title = title
    if let n = m["notes"] as? String, !n.isEmpty { r.notes = n }
    if let d = date(m["due"]) {
      let allDay = m["allDay"] as? Bool ?? true
      r.dueDateComponents = Calendar.current.dateComponents(allDay ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute], from: d)
    }
    guard let cal = pickCalendar(m["list"], for: .reminder) else { return fail(id, "no reminders list") }
    r.calendar = cal
    do { try store.save(r, commit: true); emit(["type": "done", "id": id ?? NSNull(), "reminder": reminderJSON(r)]) } catch { fail(id, error.localizedDescription) }
  case "reminder-complete", "reminder-update":
    guard let rid = m["reminderId"] as? String ?? m["reminder"] as? String, let r = store.calendarItem(withIdentifier: rid) as? EKReminder else { return fail(id, "no such reminder") }
    if cmd == "reminder-complete" { r.isCompleted = !(m["undo"] as? Bool ?? false) }
    else {
      if let t = m["title"] as? String, !t.isEmpty { r.title = t }
      if m["due"] is NSNull { r.dueDateComponents = nil }
      else if let d = date(m["due"]) { let allDay = m["allDay"] as? Bool ?? true; r.dueDateComponents = Calendar.current.dateComponents(allDay ? [.year, .month, .day] : [.year, .month, .day, .hour, .minute], from: d) }
      if let n = m["notes"] as? String { r.notes = n }
    }
    do { try store.save(r, commit: true); emit(["type": "done", "id": id ?? NSNull(), "reminder": reminderJSON(r)]) } catch { fail(id, error.localizedDescription) }
  case "quit": exit(0)
  default: fail(id, "unknown command \(cmd)")
  }
}

// Changes anywhere (ARES, Calendar.app, the phone, the web once macOS syncs): one line, debounced
NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in
  changeTimer?.invalidate()
  changeTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in emit(["type": "changed"]) }
}

// ---- Transport: the socket ARES listens on, or stdin ----------------------------------------------------------------------
func serve(reading fd: Int32) {
  DispatchQueue.global().async {
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65_536)
    while true {
      let n = read(fd, &chunk, chunk.count)
      if n <= 0 { exit(0) } // ARES hung up
      buf.append(chunk, count: n)
      while let nl = buf.firstIndex(of: 10) {
        let line = buf.subdata(in: 0..<nl)
        buf.removeSubrange(0...nl)
        guard !line.isEmpty, let m = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(m) }
      }
    }
  }
}
if let i = args.firstIndex(of: "--serve"), i + 1 < args.count {
  let path = args[i + 1]
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  _ = withUnsafeMutablePointer(to: &addr.sun_path) { p in path.withCString { strncpy(UnsafeMutableRawPointer(p).assumingMemoryBound(to: CChar.self), $0, 103) } }
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) } } == 0
  if !ok { exit(1) }
  outFD = fd
  serve(reading: fd)
} else {
  serve(reading: 0)
}
emit(["type": "ready"])
emit(permission())
RunLoop.main.run()
