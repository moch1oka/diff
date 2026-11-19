// Image export: draws the diff that's on screen straight onto a <canvas>.
//
// This replaces html-to-image, which cloned every DOM node together with all of its
// computed styles into an SVG <foreignObject> and rasterized that. On a full episode
// that froze the page for seconds, and the clone lost fonts/row heights so text and
// highlights came out misaligned. Here we only read the text, the <del>/<ins> marks
// and the colors from the rendered table, then lay the rows out ourselves.

type Mark = 'del' | 'ins' | null

interface Piece {
  text: string
  mark: Mark
}

interface Cell {
  nums: string[] // one number (side by side) or two (unified: old/new)
  prefix: string
  pieces: Piece[]
  info: boolean // @@ hunk header
  bg: string
  color: string
  numBg: string
  numColor: string
}

interface MeasuredPiece extends Piece {
  w: number
}

interface LaidOutRow {
  cells: Cell[]
  lines: MeasuredPiece[][][] // per cell, per wrapped line
  height: number
}

const PAD_X = 8
const PAD_Y = 3
const NUM_PAD = 8
const HEADER_HEIGHT = 36
const MAX_CANVAS_HEIGHT = 30000 // device px; browsers cap canvas height around 32k

function isTransparent (color: string): boolean {
  return !color || color === 'transparent' || /rgba\(.*,\s*0\)$/.test(color)
}

function fontOf (style: CSSStyleDeclaration): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
}

function collectPieces (node: Node, mark: Mark, out: Piece[], markColors: Map<string, string>) {
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child as Text).data.replace(/\u00a0/g, ' ')
      if (text) out.push({ text, mark })
    } else if (child instanceof HTMLElement) {
      let childMark = mark
      if (child.tagName === 'DEL' || child.tagName === 'INS') {
        childMark = child.tagName === 'DEL' ? 'del' : 'ins'
        if (!markColors.has(childMark)) markColors.set(childMark, getComputedStyle(child).backgroundColor)
      }
      collectPieces(child, childMark, out, markColors)
    }
  })
}

function readCell (tr: Element, pageBg: string, markColors: Map<string, string>): Cell {
  const numCell = tr.querySelector<HTMLElement>('.d2h-code-side-linenumber, .d2h-code-linenumber')
  const codeCell = tr.querySelector<HTMLElement>('td:not(.d2h-code-side-linenumber):not(.d2h-code-linenumber)')
  const subNums = numCell ? numCell.querySelectorAll('.line-num1, .line-num2') : null
  const nums = subNums && subNums.length > 0
    ? Array.from(subNums, n => n.textContent.trim())
    : [numCell ? numCell.textContent.trim() : '']

  const info = !!codeCell && codeCell.classList.contains('d2h-info')
  const pieces: Piece[] = []
  let prefix = ''
  if (codeCell) {
    const ctn = codeCell.querySelector('.d2h-code-line-ctn')
    if (info || !ctn) {
      const text = codeCell.textContent.trim()
      if (text) pieces.push({ text, mark: null })
    } else {
      collectPieces(ctn, null, pieces, markColors)
      prefix = (codeCell.querySelector('.d2h-code-line-prefix')?.textContent || '').replace(/\u00a0/g, ' ').trim()
    }
  }

  const codeStyle = codeCell ? getComputedStyle(codeCell) : null
  const numStyle = numCell ? getComputedStyle(numCell) : null
  return {
    nums,
    prefix,
    pieces,
    info,
    bg: codeStyle && !isTransparent(codeStyle.backgroundColor) ? codeStyle.backgroundColor : pageBg,
    color: codeStyle ? codeStyle.color : '#fff',
    numBg: numStyle && !isTransparent(numStyle.backgroundColor) ? numStyle.backgroundColor : pageBg,
    numColor: numStyle ? numStyle.color : '#fff'
  }
}

// Greedy word wrap that keeps the del/ins mark of every piece
function wrapPieces (pieces: Piece[], maxWidth: number, measure: (s: string) => number): MeasuredPiece[][] {
  const lines: MeasuredPiece[][] = [[]]
  let lineWidth = 0
  const push = (text: string, mark: Mark, w: number) => {
    const line = lines[lines.length - 1]
    const last = line[line.length - 1]
    if (last && last.mark === mark) {
      last.text += text
      last.w += w
    } else {
      line.push({ text, mark, w })
    }
    lineWidth += w
  }
  const newLine = () => {
    lines.push([])
    lineWidth = 0
  }

  // Words are runs of non-space characters; one word can span several marks
  // (e.g. a highlighted "money" followed by an unhighlighted "."), and must not be split there.
  const tokens: Array<{ space: boolean, parts: Piece[] }> = []
  for (const piece of pieces) {
    for (const chunk of piece.text.split(/(\s+)/)) {
      if (!chunk) continue
      const space = /^\s+$/.test(chunk)
      const last = tokens[tokens.length - 1]
      if (last && !last.space && !space) last.parts.push({ text: chunk, mark: piece.mark })
      else tokens.push({ space, parts: [{ text: chunk, mark: piece.mark }] })
    }
  }

  for (const token of tokens) {
    const widths = token.parts.map(p => measure(p.text))
    const w = widths.reduce((a, b) => a + b, 0)
    if (lineWidth + w <= maxWidth) {
      token.parts.forEach((p, i) => push(p.text, p.mark, widths[i]))
    } else if (token.space) {
      newLine() // wrap at the space and drop it
    } else if (lineWidth > 0 && w <= maxWidth) {
      newLine()
      token.parts.forEach((p, i) => push(p.text, p.mark, widths[i]))
    } else {
      // A single word wider than the column: break it anywhere
      for (const p of token.parts) {
        for (const ch of p.text) {
          const cw = measure(ch)
          if (lineWidth > 0 && lineWidth + cw > maxWidth) newLine()
          push(ch, p.mark, cw)
        }
      }
    }
  }
  return lines
}

function downloadCanvas (canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('The browser could not encode the image (too large?)'))
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.download = filename
      link.href = url
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      resolve()
    }, 'image/png')
  })
}

/**
 * Exports the rendered diff in `diffEl` as PNG. With `selectionOnly`, only the rows
 * highlighted by clicking line numbers are exported. Very tall diffs are split into
 * several images. Returns the number of images written.
 */
export async function exportDiffImage (diffEl: HTMLElement, selectionOnly: boolean, baseName = 'evadiff'): Promise<number> {
  await document.fonts.ready

  const tbodies = Array.from(diffEl.querySelectorAll('.d2h-diff-tbody'))
  if (tbodies.length === 0) throw new Error('Nothing to export')
  const rowCount = tbodies[0].children.length
  let indices = Array.from({ length: rowCount }, (_, i) => i)
  if (selectionOnly) {
    indices = indices.filter(i => tbodies[0].children[i].classList.contains('highlight'))
    if (indices.length === 0) throw new Error('No lines selected')
  }

  // Page-level colors and fonts, taken from the live CSS so the image matches the screen
  const bodyStyle = getComputedStyle(document.body)
  const pageBg = isTransparent(bodyStyle.backgroundColor) ? '#ffffff' : bodyStyle.backgroundColor
  const wrapper = diffEl.querySelector('.d2h-file-wrapper')
  const borderColor = wrapper ? getComputedStyle(wrapper).borderTopColor : bodyStyle.color
  const titleEl = diffEl.querySelector('.d2h-file-name')
  const titleStyle = getComputedStyle(titleEl || document.body)
  const title = titleEl ? titleEl.textContent.trim() : ''
  const headerEl = diffEl.querySelector('.d2h-file-header')
  const headerBg = headerEl && !isTransparent(getComputedStyle(headerEl).backgroundColor) ? getComputedStyle(headerEl).backgroundColor : pageBg
  const codeSample = diffEl.querySelector('.d2h-code-line-ctn') || diffEl.querySelector('.d2h-code-side-line, .d2h-code-line') || document.body
  const codeStyle = getComputedStyle(codeSample)
  const codeFont = fontOf(codeStyle)
  const fontSize = parseFloat(codeStyle.fontSize) || 13
  const lineHeight = Math.ceil(Math.max(parseFloat(codeStyle.lineHeight) || 0, fontSize * 1.45))
  const numSample = diffEl.querySelector('.d2h-code-side-linenumber, .d2h-code-linenumber') || codeSample
  const numFont = fontOf(getComputedStyle(numSample))

  // Read the rows. For a selection, take the highlight off while reading so the rows
  // keep their normal del/ins colors (it's put back right after, before any repaint).
  const markColors = new Map<string, string>()
  const highlighted = selectionOnly ? Array.from(diffEl.querySelectorAll('tr.highlight')) : []
  highlighted.forEach(tr => tr.classList.remove('highlight'))
  let cellsPerRow: Cell[][]
  try {
    cellsPerRow = indices.map(i => tbodies.map(tbody => readCell(tbody.children[i], pageBg, markColors)))
  } finally {
    highlighted.forEach(tr => tr.classList.add('highlight'))
  }

  // Layout
  const measureCanvas = document.createElement('canvas').getContext('2d')
  const cache = new Map<string, number>()
  const measureWith = (font: string) => (text: string) => {
    const key = font + '\u0000' + text
    let w = cache.get(key)
    if (w === undefined) {
      measureCanvas.font = font
      w = measureCanvas.measureText(text).width
      cache.set(key, w)
    }
    return w
  }
  const measureCode = measureWith(codeFont)
  const measureNum = measureWith(numFont)

  const sides = tbodies.length
  const screenWidth = wrapper ? wrapper.clientWidth : 1200
  const width = Math.round(Math.min(1600, Math.max(900, screenWidth)))
  const sideWidth = width / sides
  const numsPerCell = Math.max(1, ...cellsPerRow.map(cells => cells[0].nums.length))
  const numColWidth = Math.ceil(Math.max(measureNum('0000'), ...cellsPerRow.flatMap(cells => cells.flatMap(c => c.nums.map(measureNum))))) + NUM_PAD
  const numWidth = numColWidth * numsPerCell + NUM_PAD
  const prefixWidth = Math.ceil(measureCode('+')) + 4
  const textWidth = sideWidth - numWidth - PAD_X * 2 - prefixWidth

  const rows: LaidOutRow[] = cellsPerRow.map(cells => {
    const lines = cells.map(cell => wrapPieces(cell.pieces, cell.info ? sideWidth - numWidth - PAD_X * 2 : textWidth, measureCode))
    const lineCount = Math.max(1, ...lines.map(l => l.length))
    return { cells, lines, height: lineCount * lineHeight + PAD_Y * 2 }
  })

  // Split into several images if one would exceed the browser's canvas limits
  // Match the screen's sharpness (1x-2x); a fixed 2x made full-episode PNGs 10+ MB
  const preferredScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
  const totalHeight = HEADER_HEIGHT + rows.reduce((sum, r) => sum + r.height, 0) + 1
  const scale = totalHeight * preferredScale <= MAX_CANVAS_HEIGHT
    ? preferredScale
    : Math.max(1, MAX_CANVAS_HEIGHT / totalHeight)
  const maxRowsHeight = Math.floor(MAX_CANVAS_HEIGHT / scale + 1e-6) - HEADER_HEIGHT - 1
  const parts: LaidOutRow[][] = [[]]
  let partHeight = 0
  for (const row of rows) {
    if (partHeight + row.height > maxRowsHeight && parts[parts.length - 1].length > 0) {
      parts.push([])
      partHeight = 0
    }
    parts[parts.length - 1].push(row)
    partHeight += row.height
  }

  for (let p = 0; p < parts.length; p++) {
    const partRows = parts[p]
    const height = HEADER_HEIGHT + partRows.reduce((sum, r) => sum + r.height, 0) + 1
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(width * scale)
    canvas.height = Math.ceil(height * scale)
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    ctx.textBaseline = 'middle'

    ctx.fillStyle = pageBg
    ctx.fillRect(0, 0, width, height)

    // Header with the two titles
    ctx.fillStyle = headerBg
    ctx.fillRect(0, 0, width, HEADER_HEIGHT)
    ctx.fillStyle = titleStyle.color
    ctx.font = `bold ${titleStyle.fontSize} ${titleStyle.fontFamily}`
    const partLabel = parts.length > 1 ? `  (${p + 1}/${parts.length})` : ''
    ctx.fillText(title + partLabel, PAD_X + 2, HEADER_HEIGHT / 2)
    ctx.fillStyle = borderColor
    ctx.fillRect(0, HEADER_HEIGHT - 1, width, 1)

    let y = HEADER_HEIGHT
    for (const row of partRows) {
      row.cells.forEach((cell, s) => {
        const x0 = s * sideWidth
        ctx.fillStyle = cell.numBg
        ctx.fillRect(x0, y, numWidth, row.height)
        ctx.fillStyle = cell.bg
        ctx.fillRect(x0 + numWidth, y, sideWidth - numWidth, row.height)

        const firstLineMid = y + PAD_Y + lineHeight / 2
        ctx.font = numFont
        ctx.fillStyle = cell.numColor
        ctx.textAlign = 'right'
        cell.nums.forEach((n, k) => ctx.fillText(n, x0 + NUM_PAD / 2 + numColWidth * (k + 1), firstLineMid))
        ctx.textAlign = 'left'

        ctx.font = codeFont
        let textX = x0 + numWidth + PAD_X
        if (!cell.info) {
          ctx.fillStyle = cell.color
          if (cell.prefix) ctx.fillText(cell.prefix, textX, firstLineMid)
          textX += prefixWidth
        }
        row.lines[s].forEach((line, li) => {
          const lineTop = y + PAD_Y + li * lineHeight
          let x = textX
          for (const piece of line) {
            if (piece.mark && markColors.has(piece.mark)) {
              ctx.fillStyle = markColors.get(piece.mark)
              ctx.fillRect(x, lineTop + 1, piece.w, lineHeight - 2)
            }
            ctx.fillStyle = cell.color
            ctx.fillText(piece.text, x, lineTop + lineHeight / 2)
            x += piece.w
          }
        })
      })
      y += row.height
    }

    // Divider between the two sides, and an outer border
    ctx.fillStyle = borderColor
    if (sides === 2) ctx.fillRect(sideWidth - 0.5, HEADER_HEIGHT, 1, height - HEADER_HEIGHT)
    ctx.strokeStyle = borderColor
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1)

    const suffix = parts.length > 1 ? `-${p + 1}` : ''
    await downloadCanvas(canvas, `${baseName}${suffix}.png`)
    canvas.width = canvas.height = 0 // free the memory right away
  }
  return parts.length
}
