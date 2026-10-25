import Foundation

/// PowerPoint, written by hand like the Word export, the same parts the
/// desktop writes (packages/ui/src/export/pptx.ts): one master, one blank
/// layout, a theme; each slide a picture behind (a page drawn without its
/// text) and text boxes on it. Used by PDF → PowerPoint (each page a slide,
/// its text editable where it was) and by "make a presentation" (a title
/// slide and slides of points, laid out in ZOOD's look).
enum PptxWriter {
    struct Text {
        /// Points from the slide's top-left corner.
        var x: Double
        var y: Double
        var width: Double
        var height: Double
        var lines: [String]
        var rtl: Bool
        /// Points.
        var size: Double
        /// `rrggbb`.
        var color = "000000"
        var bold = false
        var centered = false
        /// Bulleted lines (a deck's points), wrapped to the box.
        var bullets = false
        /// Kept for search and copy, not drawn (a scan's text).
        var hidden = false
    }

    struct Slide {
        var width: Double
        var height: Double
        /// A PNG or JPEG behind everything, filling the slide.
        var picture: Data?
        var pictureIsJPEG = false
        /// A plain colour behind everything, `rrggbb`.
        var background: String?
        /// A band of colour along the slide's top (the deck's look).
        var band: (color: String, height: Double)?
        var texts: [Text] = []
    }

    static let font = "Arial"
    private static let emuPerPoint = 12_700.0
    private static let p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    private static let a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    private static let rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    private static let packageRel = "http://schemas.openxmlformats.org/package/2006/relationships"
    private static let declaration = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
    private static var ns: String { "xmlns:a=\"\(a)\" xmlns:r=\"\(rel)\" xmlns:p=\"\(p)\"" }

    static func xml(_ text: String) -> String {
        var out = ""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            default:
                // XML 1.0 has no place for most control characters.
                if scalar.value < 0x20, scalar != "\t", scalar != "\n", scalar != "\r" { continue }
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    private static func emu(_ points: Double) -> Int { max(0, Int((points * emuPerPoint).rounded())) }

    private static func color(_ hex: String) -> String {
        hex.range(of: "^[0-9a-fA-F]{6}$", options: .regularExpression) != nil ? hex.uppercased() : "000000"
    }

    private static func textBox(_ text: Text, id: Int) -> String {
        let size = Int((min(400, max(1, text.size)) * 100).rounded())
        let fill = text.hidden
            ? "<a:solidFill><a:srgbClr val=\"000000\"><a:alpha val=\"0\"/></a:srgbClr></a:solidFill>"
            : "<a:solidFill><a:srgbClr val=\"\(color(text.color))\"/></a:solidFill>"
        let runProperties = "<a:rPr lang=\"\(text.rtl ? "ar-SA" : "en-US")\" sz=\"\(size)\"\(text.bold ? " b=\"1\"" : "") dirty=\"0\">\(fill)<a:latin typeface=\"\(font)\"/><a:cs typeface=\"\(font)\"/></a:rPr>"
        let align = text.centered ? "ctr" : (text.rtl ? "r" : "l")
        let paragraphs: String
        if text.bullets {
            // One paragraph a point, with a bullet, wrapped to the box.
            paragraphs = text.lines.map { line in
                "<a:p><a:pPr marL=\"342900\" indent=\"-342900\" algn=\"\(align)\" rtl=\"\(text.rtl ? 1 : 0)\"><a:spcBef><a:spcPts val=\"900\"/></a:spcBef><a:buFont typeface=\"\(font)\"/><a:buChar char=\"•\"/></a:pPr><a:r>\(runProperties)<a:t>\(xml(line))</a:t></a:r></a:p>"
            }.joined()
        } else {
            let runs = text.lines.map { "<a:r>\(runProperties)<a:t>\(xml($0))</a:t></a:r>" }.joined(separator: "<a:br>\(runProperties)</a:br>")
            paragraphs = "<a:p><a:pPr algn=\"\(align)\" rtl=\"\(text.rtl ? 1 : 0)\"/>\(runs)</a:p>"
        }
        let wrap = text.bullets || text.centered ? "square" : "none"
        return "<p:sp><p:nvSpPr><p:cNvPr id=\"\(id)\" name=\"Text \(id)\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>"
            + "<p:spPr><a:xfrm><a:off x=\"\(emu(text.x))\" y=\"\(emu(text.y))\"/><a:ext cx=\"\(emu(text.width))\" cy=\"\(emu(text.height))\"/></a:xfrm>"
            + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>"
            + "<p:txBody><a:bodyPr wrap=\"\(wrap)\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" rtlCol=\"\(text.rtl ? 1 : 0)\" anchor=\"t\"><a:\(text.bullets ? "normAutofit" : "noAutofit")/></a:bodyPr><a:lstStyle/>"
            + paragraphs + "</p:txBody></p:sp>"
    }

    private static func rect(id: Int, x: Double, y: Double, width: Double, height: Double, color hex: String) -> String {
        "<p:sp><p:nvSpPr><p:cNvPr id=\"\(id)\" name=\"Shape \(id)\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>"
            + "<p:spPr><a:xfrm><a:off x=\"\(emu(x))\" y=\"\(emu(y))\"/><a:ext cx=\"\(emu(width))\" cy=\"\(emu(height))\"/></a:xfrm>"
            + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"\(color(hex))\"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>"
    }

    private static func slideXML(_ slide: Slide, number: Int) -> String {
        var shapes = ""
        var id = 2
        if let background = slide.background {
            shapes += rect(id: id, x: 0, y: 0, width: slide.width, height: slide.height, color: background)
            id += 1
        }
        if slide.picture != nil {
            shapes += "<p:pic><p:nvPicPr><p:cNvPr id=\"\(id)\" name=\"Page\"/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>"
                + "<p:blipFill><a:blip r:embed=\"rId2\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>"
                + "<p:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"\(emu(slide.width))\" cy=\"\(emu(slide.height))\"/></a:xfrm>"
                + "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>"
            id += 1
        }
        if let band = slide.band {
            shapes += rect(id: id, x: 0, y: 0, width: slide.width, height: band.height, color: band.color)
            id += 1
        }
        for text in slide.texts {
            shapes += textBox(text, id: id)
            id += 1
        }
        return declaration + "<p:sld \(ns)><p:cSld><p:spTree>"
            + "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>"
            + "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
            + shapes + "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    }

    private static let emptyTree = "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>"

    private static var themeXML: String {
        let fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>"
        func line(_ w: Int) -> String { "<a:ln w=\"\(w)\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln>" }
        func colour(_ name: String, _ rgb: String) -> String { "<a:\(name)><a:srgbClr val=\"\(rgb)\"/></a:\(name)>" }
        return declaration + "<a:theme xmlns:a=\"\(a)\" name=\"ZOOD PDF\"><a:themeElements><a:clrScheme name=\"ZOOD PDF\">"
            + "<a:dk1><a:srgbClr val=\"000000\"/></a:dk1><a:lt1><a:srgbClr val=\"FFFFFF\"/></a:lt1>"
            + colour("dk2", "0B1F3A") + colour("lt2", "F4EFE6") + colour("accent1", "0B1F3A") + colour("accent2", "C9A227")
            + colour("accent3", "2E7D6B") + colour("accent4", "8E5B3E") + colour("accent5", "B23A48") + colour("accent6", "4A90C2")
            + colour("hlink", "0563C1") + colour("folHlink", "5856D6") + "</a:clrScheme>"
            + "<a:fontScheme name=\"ZOOD PDF\"><a:majorFont><a:latin typeface=\"\(font)\"/><a:ea typeface=\"\"/><a:cs typeface=\"\(font)\"/></a:majorFont>"
            + "<a:minorFont><a:latin typeface=\"\(font)\"/><a:ea typeface=\"\"/><a:cs typeface=\"\(font)\"/></a:minorFont></a:fontScheme>"
            + "<a:fmtScheme name=\"ZOOD PDF\"><a:fillStyleLst>\(fill)\(fill)\(fill)</a:fillStyleLst>"
            + "<a:lnStyleLst>\(line(6350))\(line(12700))\(line(19050))</a:lnStyleLst>"
            + "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
            + "<a:bgFillStyleLst>\(fill)\(fill)\(fill)</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
    }

    /// The .pptx of `slides`; the slide size is the first slide's.
    static func pptx(_ slides: [Slide]) -> Data {
        let width = min(4032, max(72, slides.first?.width ?? 720))
        let height = min(4032, max(72, slides.first?.height ?? 405))
        let rtl = slides.flatMap(\.texts).filter(\.rtl).count * 2 > slides.flatMap(\.texts).count
        let count = slides.count
        var zip = ZipWriter()
        func type(_ kind: String) -> String { "application/vnd.openxmlformats-officedocument.presentationml.\(kind)+xml" }
        let slideTypes = (1...max(1, count)).prefix(count).map { "<Override PartName=\"/ppt/slides/slide\($0).xml\" ContentType=\"\(type("slide"))\"/>" }.joined()
        zip.add("[Content_Types].xml", text: declaration + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
            + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
            + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
            + "<Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>"
            + "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"\(type("presentation.main"))\"/>"
            + "<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"\(type("slideMaster"))\"/>"
            + "<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"\(type("slideLayout"))\"/>"
            + "<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>"
            + "<Override PartName=\"/ppt/presProps.xml\" ContentType=\"\(type("presProps"))\"/>"
            + "<Override PartName=\"/ppt/viewProps.xml\" ContentType=\"\(type("viewProps"))\"/>"
            + "<Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"\(type("tableStyles"))\"/>"
            + slideTypes + "</Types>")
        zip.add("_rels/.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(rel)/officeDocument\" Target=\"ppt/presentation.xml\"/></Relationships>")
        let ids = (0..<count).map { "<p:sldId id=\"\(256 + $0)\" r:id=\"rId\($0 + 2)\"/>" }.joined()
        zip.add("ppt/presentation.xml", text: declaration + "<p:presentation \(ns)\(rtl ? " rtl=\"1\"" : "") saveSubsetFonts=\"1\">"
            + "<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>"
            + "<p:sldIdLst>\(ids)</p:sldIdLst><p:sldSz cx=\"\(emu(width))\" cy=\"\(emu(height))\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>")
        let next = count + 2
        let slideRels = (0..<count).map { "<Relationship Id=\"rId\($0 + 2)\" Type=\"\(rel)/slide\" Target=\"slides/slide\($0 + 1).xml\"/>" }.joined()
        zip.add("ppt/_rels/presentation.xml.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\">"
            + "<Relationship Id=\"rId1\" Type=\"\(rel)/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\(slideRels)"
            + "<Relationship Id=\"rId\(next)\" Type=\"\(rel)/presProps\" Target=\"presProps.xml\"/>"
            + "<Relationship Id=\"rId\(next + 1)\" Type=\"\(rel)/viewProps\" Target=\"viewProps.xml\"/>"
            + "<Relationship Id=\"rId\(next + 2)\" Type=\"\(rel)/theme\" Target=\"theme/theme1.xml\"/>"
            + "<Relationship Id=\"rId\(next + 3)\" Type=\"\(rel)/tableStyles\" Target=\"tableStyles.xml\"/></Relationships>")
        zip.add("ppt/slideMasters/slideMaster1.xml", text: declaration + "<p:sldMaster \(ns)><p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>\(emptyTree)</p:cSld>"
            + "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>"
            + "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst></p:sldMaster>")
        zip.add("ppt/slideMasters/_rels/slideMaster1.xml.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(rel)/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/><Relationship Id=\"rId2\" Type=\"\(rel)/theme\" Target=\"../theme/theme1.xml\"/></Relationships>")
        zip.add("ppt/slideLayouts/slideLayout1.xml", text: declaration + "<p:sldLayout \(ns) type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\">\(emptyTree)</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>")
        zip.add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(rel)/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>")
        zip.add("ppt/theme/theme1.xml", text: themeXML)
        zip.add("ppt/presProps.xml", text: declaration + "<p:presentationPr \(ns)/>")
        zip.add("ppt/viewProps.xml", text: declaration + "<p:viewPr \(ns)><p:gridSpacing cx=\"76200\" cy=\"76200\"/></p:viewPr>")
        zip.add("ppt/tableStyles.xml", text: declaration + "<a:tblStyleLst xmlns:a=\"\(a)\" def=\"{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}\"/>")
        for (index, slide) in slides.enumerated() {
            let number = index + 1
            // Each slide its own size would need a presentation per size: the
            // slide is scaled to the first one's.
            var fitted = slide
            let scale = min(width / max(1, slide.width), height / max(1, slide.height))
            if abs(scale - 1) > 0.001 {
                fitted.width = width
                fitted.height = height
                fitted.texts = slide.texts.map { text in
                    var t = text
                    t.x *= scale; t.y *= scale; t.width *= scale; t.height *= scale; t.size *= scale
                    return t
                }
            }
            zip.add("ppt/slides/slide\(number).xml", text: slideXML(fitted, number: number))
            let picture = slide.picture.map { "<Relationship Id=\"rId2\" Type=\"\(rel)/image\" Target=\"../media/page\(number).\(slide.pictureIsJPEG ? "jpeg" : "png")\"/>" } ?? ""
            zip.add("ppt/slides/_rels/slide\(number).xml.rels", text: declaration + "<Relationships xmlns=\"\(packageRel)\"><Relationship Id=\"rId1\" Type=\"\(rel)/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\(picture)</Relationships>")
            if let data = slide.picture {
                zip.add("ppt/media/page\(number).\(slide.pictureIsJPEG ? "jpeg" : "png")", data)
            }
        }
        return zip.data()
    }
}
