// 生成 macOS 风格的应用图标与菜单栏模板图标。
//
//   swift make-icons.swift icons/logo.png icons/icon.png icons/tray.png
//
// 为什么不用 npm 里的 sharp：它在平台工作区里只是 transformers 的传递依赖，
// 版本随上游漂移；CoreGraphics 是宿主自带的，产物也和系统绘制圆角的方式一致。
//
// macOS 图标规范：1024×1024 画布，内容占 824×824 的圆角矩形居中，四周留透明边距，
// 圆角半径约为内容边长的 22.5%。直接把 512 的方图当图标，就是 Dock/Launchpad 里
// 那个“太正方体”的效果——系统不会替你裁圆角。
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 4 else {
    FileHandle.standardError.write("用法：swift make-icons.swift <源 logo.png> <输出 icon.png> <输出 tray.png>\n".data(using: .utf8)!)
    exit(2)
}
let sourcePath = arguments[1]
let iconPath = arguments[2]
let trayPath = arguments[3]

func loadImage(_ path: String) -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        FileHandle.standardError.write("无法读取图片：\(path)\n".data(using: .utf8)!)
        exit(1)
    }
    return image
}

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

// ---- 应用图标：1024 画布 + 824 圆角内容 + 柔和投影 ----
let source = loadImage(sourcePath)
let canvas = 1024
let content = 824
let inset = CGFloat((canvas - content) / 2)
let radius = CGFloat(content) * 0.225
let contentRect = CGRect(x: inset, y: inset, width: CGFloat(content), height: CGFloat(content))
let context = makeContext(canvas)

// 系统图标自带一层很淡的投影，让图标在浅色 Dock 上不会“贴死”。
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.28))
context.setFillColor(CGColor(srgbRed: 0.04, green: 0.06, blue: 0.08, alpha: 1))
context.addPath(CGPath(roundedRect: contentRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
context.fillPath()
context.restoreGState()

// 圆角裁剪后按“cover”填充：源图不是正方形时居中裁切，不拉伸。
context.saveGState()
context.addPath(CGPath(roundedRect: contentRect, cornerWidth: radius, cornerHeight: radius, transform: nil))
context.clip()
let sourceAspect = CGFloat(source.width) / CGFloat(source.height)
var drawRect = contentRect
if sourceAspect > 1 {
    drawRect.size.width = contentRect.height * sourceAspect
    drawRect.origin.x = contentRect.midX - drawRect.width / 2
} else if sourceAspect < 1 {
    drawRect.size.height = contentRect.width / sourceAspect
    drawRect.origin.y = contentRect.midY - drawRect.height / 2
}
context.draw(source, in: drawRect)
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
// 模板图标由系统着色；这里画一个内含 L 形缺口的圆环，作为品牌标记的抽象。
let traySize = 44
let tray = makeContext(traySize)
let center = CGPoint(x: CGFloat(traySize) / 2, y: CGFloat(traySize) / 2)
tray.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
tray.setStrokeColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
tray.setLineWidth(3.5)
tray.setLineCap(.round)
tray.addArc(center: center, radius: 15, startAngle: .pi * 0.62, endAngle: .pi * 2.28, clockwise: false)
tray.strokePath()
tray.addArc(center: center, radius: 5.5, startAngle: 0, endAngle: .pi * 2, clockwise: false)
tray.fillPath()
writePNG(tray.makeImage()!, to: trayPath)

print("已生成 \(iconPath)（\(canvas)×\(canvas)，内容 \(content)，圆角 \(Int(radius))）与 \(trayPath)（\(traySize)×\(traySize) 模板）")
