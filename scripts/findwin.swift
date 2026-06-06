// Lists on-screen windows whose owner/name matches the arg (default "auto").
// Prints: windowNumber \t owner \t name \t x,y,w,h   (logical screen points)
// Used to target `screencapture -l<windowNumber>` at the AutoDesktop window.
import CoreGraphics
import Foundation

let needle = (CommandLine.arguments.dropFirst().first ?? "auto").lowercased()
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("CGWindowListCopyWindowInfo failed\n".data(using: .utf8)!)
    exit(1)
}
for w in list {
    let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
    let name = (w[kCGWindowName as String] as? String) ?? ""
    let num = (w[kCGWindowNumber as String] as? Int) ?? 0
    let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
    guard owner.lowercased().contains(needle) || name.lowercased().contains(needle) else { continue }
    let b = (w[kCGWindowBounds as String] as? [String: CGFloat]) ?? [:]
    let x = Int(b["X"] ?? 0), y = Int(b["Y"] ?? 0)
    let ww = Int(b["Width"] ?? 0), hh = Int(b["Height"] ?? 0)
    print("\(num)\t\(owner)\tlayer=\(layer)\tname=\(name)\t\(x),\(y),\(ww),\(hh)")
}
