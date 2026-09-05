// 生成 macOS 风格的应用图标、菜单栏模板图标与启动页圆形徽章。
//
//   swift make-icons.swift icons/deepseek-logo.svg icons/icon.png icons/tray.png [lumo-logo.png]
//
// 品牌源是 DeepSeek 鱼形 SVG（icons/deepseek-logo.svg，上游 FishLogo 路径）；ImageIO 无法
// 解码 SVG，生成器用路径解析器把 `d` 属性转成 CGMutablePath 再绘制。为什么不用 npm 里的
// sharp：它在平台工作区里只是 transformers 的传递依赖，版本随上游漂移；CoreGraphics 是
// 宿主自带的，产物也和系统绘制圆角的方式一致。
//
// macOS 图标规范：1024×1024 画布，内容占 824×824 的圆角矩形居中，四周留透明边距，
// 圆角半径约为内容边长的 22.5%。直接把 512 的方图当图标，就是 Dock/Launchpad 里
// 那个“太正方体”的效果——系统不会替你裁圆角。
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 4 || arguments.count == 5 else {
    FileHandle.standardError.write("用法：swift make-icons.swift <源 logo.svg> <输出 icon.png> <输出 tray.png> [输出 lumo-logo.png]\n".data(using: .utf8)!)
    exit(2)
}
let sourcePath = arguments[1]
let iconPath = arguments[2]
let trayPath = arguments[3]
let splashPath = arguments.count == 5 ? arguments[4] : nil

// DeepSeek 品牌蓝（与上游 FishLogo 主题一致）。
let brandBlue = CGColor(srgbRed: 0.302, green: 0.42, blue: 0.996, alpha: 1)

func makeContext(_ size: Int) -> CGContext {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
        space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .high
    return context
}

func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        FileHandle.standardError.write("无法创建输出：\(path)\n".data(using: .utf8)!)
        exit(1)
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        FileHandle.standardError.write("无法写出：\(path)\n".data(using: .utf8)!)
        exit(1)
    }
}

/// 读取 SVG 的 `d` 属性（本工程品牌源只有一条 path，取第一个即可）。
func readSVGPathData(_ path: String) -> String {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8),
          let range = text.range(of: #"d="([^"]+)""#, options: .regularExpression) else {
        FileHandle.standardError.write("无法读取路径数据：\(path)\n".data(using: .utf8)!)
        exit(1)
    }
    return String(text[range].dropFirst(3).dropLast(1))
}

/// 把 SVG path 数据（M/C/L/Z，支持相对小写）解析成 CGPath。FishLogo 只用到绝对命令，
/// 这里顺手支持相对与零整批刷新，避免以后换路径时踩坑。
func parsePathData(_ data: String) -> CGPath {
    let path = CGMutablePath()
    let regex = try! NSRegularExpression(pattern: "(?:(?<cmd>[MmLlZzCc])|(?<num>[-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?))")
    let ns = data as NSString
    let matches = regex.matches(in: data, range: NSRange(location: 0, length: ns.length))
    var command = Character("M")
    var pending: [Double] = []
    var current = CGPoint.zero // 相对命令基准点

    func flush(_ nums: [Double]) {
        var values: [CGFloat] = nums.map { CGFloat($0) }
        func take(_ n: Int) -> [CGFloat] {
            if values.isEmpty { return [0, 0, 0, 0, 0, 0].prefix(n).map { $0 } }
            if values.count < n { values.append(contentsOf: [CGFloat](repeating: values.last ?? 0, count: n - values.count)) }
            return Array(values.prefix(n))
        }
        switch command {
        case "M", "m":
            let p = take(2)
            let point = CGPoint(x: p[0], y: p[1])
            let target = command == "m" ? CGPoint(x: current.x + point.x, y: current.y + point.y) : point
            path.move(to: target); current = target
            command = command == "M" ? "L" : "l" // 多对坐标隐含 LineTo
        case "L", "l":
            let p = take(2)
            let target = command == "l" ? CGPoint(x: current.x + p[0], y: current.y + p[1]) : CGPoint(x: p[0], y: p[1])
            path.addLine(to: target); current = target
        case "C", "c":
            let p = take(6)
            let r = command == "c"
            let c1 = CGPoint(x: p[0], y: p[1]), c2 = CGPoint(x: p[2], y: p[3]), e = CGPoint(x: p[4], y: p[5])
            let c1t = r ? CGPoint(x: current.x + c1.x, y: current.y + c1.y) : c1
            let c2t = r ? CGPoint(x: current.x + c2.x, y: current.y + c2.y) : c2
            let et = r ? CGPoint(x: current.x + e.x, y: current.y + e.y) : e
            path.addCurve(to: et, control1: c1t, control2: c2t); current = et
        case "Z", "z":
            path.closeSubpath()
        default:
            break
        }
    }
    for match in matches {
        let cmdRange = match.range(at: 1)
        if cmdRange.location != NSNotFound {
            if !pending.isEmpty { flush(pending); pending = [] }
            command = Character(ns.substring(with: cmdRange))
        } else {
            let token = ns.substring(with: match.range(at: 2))
            pending.append(Double(token) ?? 0)
        }
    }
    if !pending.isEmpty { flush(pending) }
    return path
}

func makeCenteredTransform(bbox: CGRect, target: CGRect, margin: CGFloat) -> CGAffineTransform {
    let scale = (min(target.width, target.height) * (1 - margin)) / max(bbox.width, bbox.height)
    // SVG 的 y 轴向下、CoreGraphics 的 y 轴向上：不翻转直接画会把鱼形上下颠倒。
    // 显式矩阵同时缩放与绕 x 轴翻转，并保证 bbox 中心对到 target 中心。
    return CGAffineTransform(
        a: scale, b: 0, c: 0, d: -scale,
        tx: target.midX - scale * bbox.midX,
        ty: target.midY + scale * bbox.midY)
}

let fish = parsePathData(readSVGPathData(sourcePath))
let fishBounds = fish.boundingBoxOfPath

// ---- 应用图标：1024 画布 + 824 圆角内容 + 品牌蓝底 + 白色鱼形 + 柔和投影 ----
let canvas = 1024
let content = 824
let inset = CGFloat((canvas - content) / 2)
let radius = CGFloat(content) * 0.225
let contentRect = CGRect(x: inset, y: inset, width: CGFloat(content), height: CGFloat(content))
let context = makeContext(canvas)

// 系统图标自带一层很淡的投影，让图标在浅色 Dock 上不会“贴死”。
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.28))
context.setFillColor(brandBlue)
context.addPath(CGPath(roundedRect: contentRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
context.fillPath()
context.restoreGState()

// 圆角裁剪后绘制鱼形：白色填充（非零环绕规则与 SVG fill-rule 默认一致）。
context.saveGState()
context.addPath(CGPath(roundedRect: contentRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
context.clip()
var iconTransform = makeCenteredTransform(bbox: fishBounds, target: contentRect, margin: 0.15)
context.addPath(fish.copy(using: &iconTransform)!)
context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
context.fillPath()
context.restoreGState()

// 边缘一条 1px 的高光描边，模拟系统图标的玻璃质感。
context.saveGState()
context.addPath(CGPath(roundedRect: contentRect.insetBy(dx: 1, dy: 1), cornerWidth: radius - 1, cornerHeight: radius - 1, transform: nil))
context.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.10))
context.setLineWidth(2)
context.strokePath()
context.restoreGState()

writePNG(context.makeImage()!, to: iconPath)

// ---- 菜单栏模板图标：44×44（22pt @2x）单色，alpha 即形状 ----
// 模板图标由系统着色；形状与应用图标同源（同一 SVG 路径）。
let traySize = 44
let tray = makeContext(traySize)
let trayRect = CGRect(x: 0, y: 0, width: traySize, height: traySize)
var trayTransform = makeCenteredTransform(bbox: fishBounds, target: trayRect, margin: 0.12)
tray.addPath(fish.copy(using: &trayTransform)!)
tray.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
tray.fillPath()
writePNG(tray.makeImage()!, to: trayPath)

// ---- 启动页圆形徽章：512×512 全出血圆盘（品牌蓝底 + 白色鱼形 + 1px 高光边缘），圆外透明 ----
// boot.html 的 .mark 是 54px 圆 + cover；圆盘铺满后 CSS 圆底不再露出，与 mac 应用图标同色系。
var splashSummary = ""
if let splashPath = splashPath {
    let splashSize = 512
    let splash = makeContext(splashSize)
    let splashRect = CGRect(x: 0, y: 0, width: CGFloat(splashSize), height: CGFloat(splashSize))
    let disc = CGPath(ellipseIn: splashRect, transform: nil)
    splash.addPath(disc)
    splash.setFillColor(brandBlue)
    splash.fillPath()
    splash.saveGState()
    splash.addPath(disc)
    splash.clip()
    var splashTransform = makeCenteredTransform(bbox: fishBounds, target: splashRect, margin: 0.18)
    splash.addPath(fish.copy(using: &splashTransform)!)
    splash.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    splash.fillPath()
    splash.restoreGState()
    splash.saveGState()
    splash.addPath(CGPath(ellipseIn: splashRect.insetBy(dx: 1.2, dy: 1.2), transform: nil))
    splash.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.10))
    splash.setLineWidth(1.2)
    splash.strokePath()
    splash.restoreGState()
    writePNG(splash.makeImage()!, to: splashPath)
    splashSummary = "、启动页徽章 \(splashPath)（\(splashSize)×\(splashSize) 圆盘）"
}

print("已生成 \(iconPath)（\(canvas)×\(canvas)，内容 \(content)，圆角 \(Int(radius))）与 \(trayPath)（\(traySize)×\(traySize) 模板）\(splashSummary)")
