import subsrt from 'subsrt'
import { createTwoFilesPatch } from 'diff'
import { exportDiffImage } from './export'
// The plain renderer, not Diff2HtmlUI: the UI wrapper pulls in all of highlight.js,
// and we don't use syntax highlighting
import { html as diffToHtml } from 'diff2html'
import type { LineMatchingType, OutputFormatType } from 'diff2html/lib/types'
import 'diff2html/bundles/css/diff2html.min.css'
import './main.css' // after diff2html's CSS so our overrides win

const exportAllBtn = document.getElementById('export-all') as HTMLButtonElement
const exportSelectionBtn = document.getElementById('export-selection') as HTMLButtonElement
let exporting = false

function selectedLineCount (): number {
  const tbody = document.querySelector('#diff .d2h-diff-tbody')
  return tbody ? tbody.querySelectorAll(':scope > tr.highlight').length : 0
}

function updateExportButtons () {
  const count = selectedLineCount()
  exportAllBtn.disabled = exporting
  exportSelectionBtn.disabled = exporting || count === 0
  if (!exporting) {
    exportSelectionBtn.textContent = count > 0
      ? `Export selection (${count} ${count === 1 ? 'line' : 'lines'})`
      : 'Export selection'
  }
}

async function runExport (button: HTMLButtonElement, selectionOnly: boolean) {
  if (exporting) return
  exporting = true
  const label = button.textContent
  button.textContent = 'Exporting...'
  updateExportButtons()
  // Let the button state paint before the (synchronous) layout work starts
  await new Promise(resolve => setTimeout(resolve, 0))
  try {
    const images = await exportDiffImage(document.getElementById('diff'), selectionOnly, selectionOnly ? 'evadiff-selection' : 'evadiff')
    if (images > 1) showStatus(`The diff was too tall for one image, saved it as ${images} images.`, 8000)
  } catch (error) {
    console.error(error)
    showStatus('Image export failed: ' + error.message, 8000)
  } finally {
    exporting = false
    button.textContent = label
    updateExportButtons()
  }
}

exportAllBtn.addEventListener('click', () => runExport(exportAllBtn, false))
exportSelectionBtn.addEventListener('click', () => runExport(exportSelectionBtn, true))

const input = document.querySelector('input')
const droparea = document.querySelector('.file-drop-area')
const statusEl = document.querySelector<HTMLElement>('.file-msg')
const statusInit = statusEl.textContent
const diffFiles = {}
// excludedStyles and replacements are keyed by file hash, so they stay with the file when A/B are swapped
const diffOptions = { fileA: null, fileB: null, excludedStyles: {}, replacements: {}, sortByTime: false, stripTags: true, removeEmptyLines: true, normalizeWhitespace: true, normalizeCharacters: true, removePosLines: true, removeDrawLines: true, mergeDuplicateLines: true, mergeAlphaTiming: false, removeSpecialCharacters: false, ignorePunctuation: false, ignoreHonorifics: false, removeHonorifics: false, lowerCase: false, diffMatching: 'words' as LineMatchingType, diffOutputFormat: 'side-by-side' as OutputFormatType }
const checkboxOptions = { /* sortByTime: 'Sort by time', */ stripTags: 'Strip tags', removeEmptyLines: 'Remove empty lines', normalizeWhitespace: 'Normalize whitespace', normalizeCharacters: 'Normalize characters', removePosLines: 'Remove \\pos lines', removeDrawLines: 'Remove \\p (drawing) lines', mergeDuplicateLines: 'Merge duplicate lines', mergeAlphaTiming: 'Merge alpha timing', removeSpecialCharacters: 'Remove special characters', removeHonorifics: 'Remove honorifics', lowerCase: 'Convert to lowercase', ignorePunctuation: 'Ignore punctuation changes', ignoreHonorifics: 'Ignore honorific changes' }
const selectOptions = {
  diffOutputFormat: { label: 'Layout', choices: { 'side-by-side': 'Side by side', 'line-by-line': 'Unified' } },
  diffMatching: { label: 'Matching', choices: { words: 'Words', lines: 'Lines', none: 'None' } }
}

const opts = document.getElementById('globalopt')
for (const option in checkboxOptions) {
  const label = document.createElement('label')
  label.htmlFor = 'chk-' + option
  label.textContent = checkboxOptions[option]
  label.classList.add('fileinfo')
  const opt = document.createElement('div')
  opt.id = 'opt-' + option
  opt.classList.add('option')
  const chk = document.createElement('input')
  chk.id = 'chk-' + option
  chk.type = 'checkbox'
  chk.checked = diffOptions[option]
  label.appendChild(opt)
  opt.appendChild(chk)
  chk.addEventListener('change', () => {
    diffOptions[option] = chk.checked
    diffUpdate()
  })
  opts.appendChild(label)
}

for (const option in selectOptions) {
  const label = document.createElement('label')
  label.htmlFor = 'sel-' + option
  label.textContent = selectOptions[option].label
  label.classList.add('fileinfo', 'selectopt')
  const sel = document.createElement('select')
  sel.id = 'sel-' + option
  for (const value in selectOptions[option].choices) {
    const choice = document.createElement('option')
    choice.value = value
    choice.textContent = selectOptions[option].choices[value]
    sel.appendChild(choice)
  }
  sel.value = diffOptions[option]
  sel.addEventListener('change', () => {
    diffOptions[option] = sel.value
    diffUpdate()
  })
  label.appendChild(sel)
  opts.appendChild(label)
}

function clearStatus () {
  statusEl.textContent = statusInit
}

let statusTimer
function showStatus (message: string, timeout = 4000) {
  clearTimeout(statusTimer)
  statusEl.textContent = message
  statusEl.title = message
  if (timeout) statusTimer = setTimeout(clearStatus, timeout)
}

// Matches a {...} override block containing \r or \rStyleName
const resetTagRegex = /\{[^}]*\\r([^\\}]*)[^}]*\}/g

function stripAssTags (text: string): string {
  return text.replace(/\{[^}]*\\p(?:0+[1-9]|[1-9]{1}\d{0,3})[^}]*\}.*?\{[^}]*\\p0.*?(?<!\\p1)\}|\{[^}]*\\p(?:0+[1-9]|[1-9]{1}\d{0,3}).*$/g, '').replace(/\{[^}]*\}/g, '').replace(/\\h/g, ' ').replace(/\s?\\n\s?/g, ' ').replace(/\s?\\N\s?/g, '\r\n')
}

// Keeps only the parts of an ASS line whose effective style (the line's own style,
// or the one switched to with \r) is not excluded. Returns null if nothing is left.
function filterStyles (content: string, lineStyle: string, excluded: string[]): string | null {
  let style = lineStyle
  let result = ''
  let pos = 0
  let kept = false
  for (const m of content.matchAll(resetTagRegex)) {
    if (!excluded.includes(style)) {
      result += content.slice(pos, m.index)
      kept = true
    }
    style = m[1] || lineStyle
    if (!excluded.includes(style)) result += m[0]
    pos = m.index + m[0].length
  }
  if (!excluded.includes(style)) {
    result += content.slice(pos)
    kept = true
  }
  return kept ? result : null
}

function collectStyles (parsed): Map<string, number> {
  const styles = new Map<string, number>()
  parsed.forEach(line => {
    if (line.type !== 'caption' || !line.data || !line.data.Style) return
    const used = new Set([line.data.Style])
    for (const m of line.content.matchAll(resetTagRegex)) {
      if (m[1]) used.add(m[1])
    }
    used.forEach(style => styles.set(style, (styles.get(style) || 0) + 1))
  })
  return styles
}

function handleLines (data, options): string[] {
  const lines: string[] = []
  // TODO: sortByTime
  data.forEach(line => {
    if (line.type !== 'caption') return

    let text = options.stripTags ? line.text : line.content

    const lineStyle = line.data && line.data.Style
    if (lineStyle && options.excludedStyles.length > 0) {
      const filtered = filterStyles(line.content, lineStyle, options.excludedStyles)
      if (filtered === null) return
      if (filtered !== line.content) {
        // TODO: if VTT or SRT, decode HTML entities
        text = options.stripTags ? stripAssTags(filtered) : filtered
      }
    }

    if (options.removePosLines && /\{[^}]*\\pos/.test(line.content)) return
    if (options.removeDrawLines && /\{[^}]*\\p[0-9 .\-\\}]/.test(line.content)) return

    if (options.removeEmptyLines && text.replace(/\xa0/g, ' ').trim() === '') return

    if (options.normalizeCharacters) {
      text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/…/g, '...')
    }

    if (options.removeSpecialCharacters) {
      text = text.replace(/[.,/#!$%^&*;:{}=\-_`~()…?–—]/g, '')
    }

    if (options.removeHonorifics) {
      text = text.replace(/\b-(?:san|sama|kun|chan|tan|senpai|sensei|kohai|hakase|neechan|oneesan|oneesama|oneechan|onichan|onisan|obasan|oobasan|neesan|aneki|aniki|zeki|han|niichan|dono|ojosama|niisan|oniisama|ojisan|nee|nii)\b/gi, '')
    }

    if (options.normalizeWhitespace) {
      text = text.replace(/\xa0/g, ' ').replace(/\s+/g, ' ').trim()
    }

    for (const rep in options.replace) {
      // TODO: allow regex?
      text = text.split(rep).join(options.replace[rep]) // replace every occurrence, not just the first
    }

    if (options.lowerCase) {
      text = text.toLowerCase()
    }

    const prev = lines[lines.length - 1]
    if (prev === text) {
      if (options.mergeDuplicateLines) return
    } else if (options.mergeAlphaTiming && prev !== undefined && text.startsWith(prev)) {
      lines[lines.length - 1] = text
      return
    }

    lines.push(text)
  })
  return lines
}

function guessGroup (filename) {
  const discordStyle = filename.match(/^([A-Za-z0-9-]+)_[A-Za-z_]+_-_(?:[Ss]\d+)?[Ee]?\d+[_.]/)
  if (discordStyle) return discordStyle[1]

  const groupBlacklist = ['xvid', 'x264', 'x265', 'avc', 'hevc', 'dvd', 'dvd5', 'dvd9', 'dvdiso', 'dvd-r', 'dvdr', 'movie', '4k', '2160p', '1080p', '720p', '576p', '480p', '2160', '1080', '720', '576', '480', 'bluray', 'bdmv', 'bdiso', 'proper', 'aac', 'ac3', 'flac', 'vob', 'ifo', 'vob ifo', 'vob.ifo', 'vob_ifo', 'avi', 'remux', 'uncut', 'dl', 'us', 'r', 'j', 'jp', 'jpn', 'ita', 'dvdrip', 'pal', 'ntsc', 'bd', 'bdremux', 'bdremux.1080p', '1080p remux', 'hd', 'eng', 'exclusive', 'japanese', 'nogrp', 'nogroup', '3d half sbs', 'r1', 'r2', 'r2j', 'extras', 'trailers', 'rifftrax', 'cd1', 'cd2']
  const groupRegex = /^\[(?!Japanese)(?:[0-9]+[pP]?|MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|([^[\u4E00-\u9FCC¶^\]]+))\](?!\[).*|^\[(?!Japanese)(?:MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|\d{6}|([^½ \]\u4E00-\u9FCC]+))\].*|.*[a-zA-Z .\]]\[(?:.* Edition|[rR]iff[tT]rax|REMUX|PROPER|MOVIE|DVD(?:[95]|ISO|R).*|BD(?:MV|\d+)|AC3|AAC|.* DVD|[0-9]+[pP]?|.*?26[45]+.*?|[a-f0-9]{8}|[A-F0-9]{8}|.*FLAC|R2[ JFD].*|([^[)+-]+))](?:\[[0-9]+[pP]])$|.*(?:\.|[xhXH]\.?26[45] )(?:REMUX|PROPER|MOVIE|DVD(?:[95]|ISO|-?R)?|BD(?:MV|\d+)|AC3|AAC|FLAC|PAL|NTSC|XVID|DTS|DUB|[xhXH]\.?26[45]|(?![cC][dD]\d|BLURAY)([A-Z]-)?([A-Z][A-Zi0-9]+|[A-Z][a-z][A-Z]|@[a-zA-Z]{2,}))$|^(lazers|neroz)-[a-z0-9-]+$|^([a-z]{3,4}|refined|publichd)(?:-[a-z0-9-]*|(?:\.EXTRAS)?\.[a-z0-9.]*)\.?(?:2160|1080|720|480)p?$|.*(?:WEB-DL|10-bit|(?:_-_|(?:[ \d]- )(?!DTS-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|WB|[xhXH]\.?26[45]|[aA][vV][iI]|Uncut|Untouched|DVDRIP|Extras|Trailers|Copy|[rR]iff[tT]rax|[a-z]*1080p|[([]?\d+|[bB][iI]|[cC][dD]\d|([^ .\])_~]+)))\)?$|.*(?:WEB-DL|10-bit|(?:_-_|(?:-([A-Z][A-Z0-9]-)|...-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|[xhXH]\.?26[45]|Uncut|Untouched|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|([^ .\])]+)))-Exclusive\)?$|.*(?:[bB]lu-[rR]ay|WEB-DL|10-bit|(?:_-_|(?:S-([A-WYZ][A-Z0-9]?-)|[^S]-([A-Z][A-Z0-9]?-)|(FTW-)|.(?!BD-[JKR][)\]]?$).(?!3-D$).-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|X|[xhXH]\.?26[45]|Uncut|Untouched|[mM]ovie|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|\[([A-Z]+|[a-z]+)]|((?:[A-Z]\.?)+|[^ .\])]+(?:\[\d+])?)))\)?$|.*(?:[bB]lu-[rR]ay|WEB-DL|10-bit|(?:_-_|(?:S-([A-WYZ][A-Z0-9]?-)|[^S]-([A-Z][A-Z0-9]?-)|(FTW-)|.(?!BD-[JKR][)\]]?$).(?!3-D$).-|~))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|X|[xhXH]\.?26[45]|Uncut|Untouched|[mM]ovie|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|\[([A-Z]+|[a-z]+)]|((?:[A-Z]\.?)+|[^ .\])]+(?:\[\d+])?)))\)?$|^[a-z]{3}_\[(?:[0-9]+[pP]?|MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|([^[\u4E00-\u9FCC]+))\]|^([a-z]{2,3})\..*|.*?(?:\[((?:[A-Z]{3}-)?[A-Z][a-z]{3,})\]) ?\[(?:[a-f0-9]{8}|[A-F0-9]{8})]$|(?!DVD-R).*[a-zA-Z .\]]\[(?:.* Edition|[rR]iff[tT]rax|REMUX|PROPER|MOVIE|PAL|(?:PAL.)?DVD(?:[95]|ISO|R).*|BD(?:MV|\d+)|AC3|AAC|.* DVD|[0-9]+[pP]?|.*?26[45]+.*?|[a-f0-9]{8}|[A-F0-9]{8}|.*FLAC|Eng|Ita|R\d(?:J|FR)?|.*DVD\.XviD|VOB.IFO|R2[ JFD].*|EXTRAS.*|\d+p [rR]emux|.*, \d{4}|([^[)+-]+))]$|^([a-z]+)-.*(?:[0-9]+[pP]?$)|^[a-z]{2}-([a-z]{3})$|^(?:[A-Z_]|3D)+_(?:REMUX|BLURAY|([A-Zi]{2,4}HD|HD[A-Z]{4}))$|.*\d\.\d ([a-z]{4}|[A-Z][a-z]+[A-Z]+)$|.*\.\d{4}\.BDrip\.([A-Z][a-z]+[A-Z][a-z]+)$|.*(?:-AC3|\.[xX][vV][iI][dD]|\.dxva)\.([a-z0-9]+|[A-Zi0-9]+|[A-Z][a-z]+[A-Z])$|.+/g
  const groupName = filename.replace(/\.[^/.]+$/, '').trim().replace('DTS-HD-', '-').replace(groupRegex, '$1$2$3$4$5$6$7$8$9$10$11$12$13$14$15$16$17$18$19$20$21$22$23$24$25$26$27$28$29$30$31$32$33')
  return (groupName && groupName.length > 0 && !groupBlacklist.includes(groupName.toLowerCase())) ? groupName : filename
}

function fileList () {
  const flist = document.getElementById('filelist')
  for (const hash in diffFiles) {
    if (document.getElementById('file-' + hash)) continue
    const entry = document.createElement('div')
    entry.classList.add('fileentry')

    const info = document.createElement('button')
    info.type = 'button'
    info.id = 'file-' + hash
    info.classList.add('fileinfo')
    info.append(diffFiles[hash].title + ' (' + diffFiles[hash].format + ')', document.createElement('br'), diffFiles[hash].filename)
    info.addEventListener('click', () => toggleFile(hash, info))
    info.addEventListener('animationend', () => info.classList.remove('denied'))

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.classList.add('fileremove')
    remove.textContent = '×'
    remove.title = 'Remove file'
    remove.setAttribute('aria-label', 'Remove ' + diffFiles[hash].title)
    remove.addEventListener('click', () => removeFile(hash, entry))

    entry.append(info, remove)
    flist.appendChild(entry)
  }
  updateSelection()
}

// Syncs the file buttons with diffOptions.fileA/fileB (highlight + A/B badge)
function updateSelection () {
  for (const hash in diffFiles) {
    const info = document.getElementById('file-' + hash)
    if (!info) continue
    const slot = hash === diffOptions.fileA ? 'A' : hash === diffOptions.fileB ? 'B' : null
    info.classList.toggle('is-active', slot !== null)
    info.setAttribute('aria-pressed', String(slot !== null))
    if (slot) info.dataset.slot = slot
    else delete info.dataset.slot
  }
}

function toggleFile (hash: string, info: HTMLElement) {
  if (hash === diffOptions.fileA) {
    diffOptions.fileA = null
  } else if (hash === diffOptions.fileB) {
    diffOptions.fileB = null
  } else if (diffOptions.fileA == null) {
    diffOptions.fileA = hash
  } else if (diffOptions.fileB == null) {
    diffOptions.fileB = hash
  } else {
    showStatus('Only two files can be compared, deselect one first.')
    info.classList.remove('denied')
    info.getBoundingClientRect() // force a reflow so the shake animation restarts
    info.classList.add('denied')
    return
  }
  updateSelection()
  diffUpdate()
}

function removeFile (hash: string, entry: HTMLElement) {
  if (hash === diffOptions.fileA) diffOptions.fileA = null
  if (hash === diffOptions.fileB) diffOptions.fileB = null
  delete diffFiles[hash]
  delete diffOptions.excludedStyles[hash]
  delete diffOptions.replacements[hash]
  entry.remove()
  updateSelection()
  diffUpdate()
}

// Swap button + per-file style toggles. Only rebuilt when the A/B selection changes,
// so toggling a checkbox doesn't destroy (and unfocus) the controls.
let renderedSelection = null
function renderFileOptions () {
  const key = diffOptions.fileA + '|' + diffOptions.fileB
  if (key === renderedSelection) return
  renderedSelection = key

  const container = document.getElementById('fileopt')
  container.textContent = ''

  if (diffOptions.fileA && diffOptions.fileB) {
    const swap = document.createElement('button')
    swap.type = 'button'
    swap.classList.add('fake-btn', 'swap-btn')
    swap.textContent = 'Swap A ⇄ B'
    swap.addEventListener('click', () => {
      [diffOptions.fileA, diffOptions.fileB] = [diffOptions.fileB, diffOptions.fileA]
      updateSelection()
      diffUpdate()
    })
    container.appendChild(swap)
  }

  ;[['A', diffOptions.fileA], ['B', diffOptions.fileB]].forEach(([slot, hash]) => {
    if (!hash || diffFiles[hash].styles.size === 0) return
    const excluded: string[] = diffOptions.excludedStyles[hash] = diffOptions.excludedStyles[hash] || []

    const box = document.createElement('fieldset')
    box.classList.add('styleopt')
    const legend = document.createElement('legend')
    legend.textContent = slot + ': ' + diffFiles[hash].title + ' · styles'
    box.appendChild(legend)

    diffFiles[hash].styles.forEach((count, style) => {
      const label = document.createElement('label')
      const chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = !excluded.includes(style)
      chk.addEventListener('change', () => {
        const i = excluded.indexOf(style)
        if (chk.checked && i !== -1) excluded.splice(i, 1)
        else if (!chk.checked && i === -1) excluded.push(style)
        diffUpdate()
      })
      label.append(chk, ' ' + style + ' (' + count + ')')
      box.appendChild(label)
    })
    container.appendChild(box)
  })
}

function diffUpdate () {
  renderFileOptions()
  if (!diffOptions.fileA || !diffOptions.fileB) {
    document.getElementById('diff').innerHTML = ''
    document.getElementById('afterdiff').style.display = 'none'
    return
  }
  // diffOptions is spread first so the per-file values below win
  const linesA = handleLines(diffFiles[diffOptions.fileA].data, { ...diffOptions, excludedStyles: diffOptions.excludedStyles[diffOptions.fileA] || [], replace: diffOptions.replacements[diffOptions.fileA] || {} })
  const linesB = handleLines(diffFiles[diffOptions.fileB].data, { ...diffOptions, excludedStyles: diffOptions.excludedStyles[diffOptions.fileB] || [], replace: diffOptions.replacements[diffOptions.fileB] || {} })
  const titleA = diffFiles[diffOptions.fileA].title || diffFiles[diffOptions.fileA].filename || 'A'
  const titleB = diffFiles[diffOptions.fileB].title || diffFiles[diffOptions.fileB].filename || 'B'
  if (linesA.length === 0) {
    document.getElementById('diff').textContent = 'File "' + titleA + '" is empty after filtering.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  } else if (linesB.length === 0) {
    document.getElementById('diff').textContent = 'File "' + titleB + '" is empty after filtering.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  }
  if (linesA.length === linesB.length && linesA.every((l, i) => l === linesB[i])) {
    document.getElementById('diff').textContent = 'No changes between ' + titleA + ' and ' + titleB + '.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  }
  // Trailing newline on both sides so jsdiff doesn't add "\ No newline at end of file" markers
  const diff = createTwoFilesPatch(titleA, titleB, linesA.join('\n') + '\n', linesB.join('\n') + '\n', undefined, undefined, { context: 3 })
  const diffEl = document.getElementById('diff')
  diffEl.innerHTML = diffToHtml(diff, { matching: diffOptions.diffMatching, outputFormat: diffOptions.diffOutputFormat, drawFileList: false })
  syncSideScroll(diffEl)
  document.querySelectorAll('.d2h-code-side-line, .d2h-code-line').forEach(line => {
    const oline = line.innerHTML
    let nline = oline
    if (diffOptions.ignorePunctuation) {
      nline = nline.replace(/<(?:del[^>]*|ins[^>]*)>([ .,/#!$%^&*;:{}=\-_`'~()…?–—])<\/(?:del|ins)>/g, '$1')
    }
    if (diffOptions.ignoreHonorifics) {
      nline = nline.replace(/<(?:del[^>]*|ins[^>]*)>-(san|sama|kun|chan|tan|senpai|sensei|kohai|hakase|neechan|oneesan|oneesama|oneechan|onichan|onisan|obasan|oobasan|neesan|aneki|aniki|zeki|han|niichan|dono|ojosama|niisan|oniisama|ojisan|nee|nii)<\/(?:del|ins)>/g, '-$1')
    }
    nline = nline.replace(/<\/(?:del|ins)>([ .,/#!$%^&*;:{}=\-_`'~()…?–—])<(?:del[^>]*|ins[^>]*)>/g, '$1').replace(/([ '])<\/(del|ins)>/g, '</$2>$1')
    if (nline !== oline) line.innerHTML = nline
  })
  document.querySelectorAll('.d2h-ins:not(.d2h-change) .d2h-code-line-ctn').forEach(emptyLine => {
    emptyLine.innerHTML = '<ins>' + emptyLine.innerHTML + '</ins>'
  })
  document.querySelectorAll('.d2h-del:not(.d2h-change) .d2h-code-line-ctn').forEach(emptyLine => {
    emptyLine.innerHTML = '<del>' + emptyLine.innerHTML + '</del>'
  })
  document.getElementById('afterdiff').style.display = 'block'
  updateExportButtons()
}

// Side by side: scrolling one pane horizontally scrolls the other (what Diff2HtmlUI's synchronisedScroll did)
function syncSideScroll (container: HTMLElement) {
  const sides = Array.from(container.querySelectorAll<HTMLElement>('.d2h-file-side-diff'))
  if (sides.length !== 2) return
  sides.forEach((side, i) => {
    const other = sides[1 - i]
    side.addEventListener('scroll', () => {
      if (other.scrollLeft !== side.scrollLeft) other.scrollLeft = side.scrollLeft
    })
  })
}

// Clicking a line number highlights that row in both panes; shift+click extends the
// highlight into a range, clicking the only highlighted row again clears it.
// One delegated listener, so nothing has to be re-bound after each re-render.
document.getElementById('diff').addEventListener('click', (e: MouseEvent) => {
  const cell = (e.target as Element).closest('.d2h-code-side-linenumber, .d2h-code-linenumber')
  if (!cell) return
  const row = cell.parentElement
  const line = Array.from(row.parentElement.children).indexOf(row)
  // One tbody in the unified layout, two (left and right) side by side
  const tbodies = Array.from(document.querySelectorAll('#diff .d2h-diff-tbody'))
  const rowsAt = (i: number) => tbodies.map(tbody => tbody.children[i]).filter(Boolean)
  const highlighted = Array.from(tbodies[0].children)
    .map((r, i) => r.classList.contains('highlight') ? i : -1)
    .filter(i => i >= 0)

  if (e.shiftKey && highlighted.length > 0) {
    const from = Math.min(line, highlighted[0])
    const to = Math.max(line, highlighted[highlighted.length - 1])
    for (let i = from; i <= to; i++) rowsAt(i).forEach(r => r.classList.add('highlight'))
  } else {
    const wasOnlyThisLine = highlighted.length === 1 && highlighted[0] === line
    tbodies.forEach(tbody => Array.from(tbody.children).forEach(r => r.classList.remove('highlight')))
    if (!wasOnlyThisLine) rowsAt(line).forEach(r => r.classList.add('highlight'))
  }
  updateExportButtons()
})

// Fast non-cryptographic 53-bit hash (cyrb53), only used to skip files that were already added
function hashString (str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + str.length.toString(16)
}

// Returns false if the data couldn't be parsed as subtitles (true for duplicates, which are just skipped)
function addSubtitle (filename: string, data: string, title: string = null): boolean {
  // TODO: (specifically for clipboard) parse ASS title section
  if (!title) title = guessGroup(filename)

  // Files extracted from a container are often named like "Show_Track3.ass"
  const trackIndex = filename.match(/_(?:Track)?(\d+)\.[A-Za-z]{3}$/)
  if (trackIndex) title += '_' + parseInt(trackIndex[1])

  const hash = hashString(data)
  if (diffFiles[hash]) return true

  let format
  let parsed
  try {
    format = subsrt.detect(data)
    if (!format) return false
    parsed = subsrt.parse(data, { format })
  } catch (error) {
    console.error(error)
    return false
  }

  if (!parsed || parsed.length === 0) return false

  // Keep titles unique, they label the two sides of the diff
  const titles = Object.keys(diffFiles).map(f => diffFiles[f].title)
  let uniqueTitle = title
  for (let n = 2; titles.includes(uniqueTitle); n++) uniqueTitle = title + ' (' + n + ')'

  diffFiles[hash] = {
    filename,
    format,
    data: parsed,
    styles: collectStyles(parsed),
    title: uniqueTitle
  }

  fileList()

  if (!diffOptions.fileA || !diffOptions.fileB) {
    document.getElementById('file-' + hash).click()
  }
  return true
}

diffUpdate()

input.addEventListener('change', handleFiles)

document.addEventListener('paste', (e: ClipboardEvent) => {
  const paste = e.clipboardData ? e.clipboardData.getData('text') : ''
  if (paste.trim() === '') return

  if (!addSubtitle('clipboard', paste, 'Clipboard content')) {
    showStatus("Clipboard content isn't a recognized subtitle format.")
  }
})

const activeElements = ['dragenter', 'focus', 'click']
activeElements.forEach(event => input.addEventListener(event, handleDropActive))
function handleDropActive () {
  droparea.classList.add('is-active')
}

const inactiveEvents = ['dragleave', 'blur', 'drop']
inactiveEvents.forEach(event => input.addEventListener(event, handleDropInactive))
function handleDropInactive () {
  droparea.classList.remove('is-active')
}

async function handleFiles (event: Event) {
  const target = event.target as HTMLInputElement
  const files = Array.from(target.files) // copy: resetting target.value below empties the FileList
  const failed: string[] = []

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex]
    const filename = file.name
    const normalized = filename.toLowerCase()
    const progress = files.length > 1 ? `(${fileIndex + 1}/${files.length}) ` : ''
    showStatus(`Loading ${progress}${filename}...`, 0)

    try {
      if (/\.(ass|ssa|srt|vtt|txt)$/.test(normalized)) {
        if (!addSubtitle(filename, await file.text())) failed.push(filename)
      } else {
        failed.push(filename + ' (unsupported type)')
      }
    } catch (error) {
      console.error(error)
      failed.push(filename)
    }
  }

  // Allow picking the same file again (e.g. after removing it)
  target.value = ''

  if (failed.length > 0) {
    showStatus("Couldn't read: " + failed.join(', '), 8000)
  } else {
    showStatus('Done.', 2000)
  }
}
