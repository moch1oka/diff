import 'regenerator-runtime/runtime'
import fileReaderStream from 'filereader-stream'
import subsrt from 'subsrt'
import difflib from 'difflib'
import crypto from 'crypto'
const { SubtitleParser } = require('matroska-subtitles')
import { toJpeg } from 'html-to-image';

document.getElementById('jpgexport').addEventListener('click', e => {
  // JPEG has no alpha channel, so give the (transparent) diff container the page background
  toJpeg(document.getElementById('diff'), { quality: 0.95, backgroundColor: '#2a2a2a' })
  .then(function (dataUrl) {
    var link = document.createElement('a');
    link.download = 'evadiff.jpg';
    link.href = dataUrl;
    link.click();
  });
})

const input = document.querySelector('input')
const droparea = document.querySelector('.file-drop-area')
const statusEl = document.querySelector('.file-msg')
const statusInit = statusEl.textContent
const diffFiles = {}
// excludedStyles and replacements are keyed by file hash, so they stay with the file when A/B are swapped
const diffOptions = { fileA: null, fileB: null, excludedStyles: {}, replacements: {}, sortByTime: false, stripTags: true, removeEmptyLines: true, normalizeWhitespace: true, normalizeCharacters: true, removePosLines: true, removeDrawLines: true, mergeDuplicateLines: true, mergeAlphaTiming: false, removeSpecialCharacters: false, ignorePunctuation: false, ignoreHonorifics: false, removeHonorifics: false, lowerCase: false, diffMatching: 'words', diffOutputFormat: 'side-by-side' }
const checkboxOptions = { /*sortByTime: 'Sort by time',*/ stripTags: 'Strip tags', removeEmptyLines: 'Remove empty lines', normalizeWhitespace: 'Normalize whitespace', normalizeCharacters: 'Normalize characters', removePosLines: 'Remove \\pos lines', removeDrawLines: 'Remove \\p (drawing) lines', mergeDuplicateLines: 'Merge duplicate lines', mergeAlphaTiming: 'Merge alpha timing', removeSpecialCharacters: 'Remove special characters', removeHonorifics: 'Remove honorifics', lowerCase: 'Convert to lowercase', ignorePunctuation: 'Ignore punctuation changes', ignoreHonorifics: 'Ignore honorific changes' }
const selectOptions = {
  diffOutputFormat: { label: 'Layout', choices: { 'side-by-side': 'Side by side', 'line-by-line': 'Unified' } },
  diffMatching: { label: 'Matching', choices: { words: 'Words', lines: 'Lines', none: 'None' } }
}

const opts = document.getElementById('globalopt')
for (const option in checkboxOptions) {
  const label = document.createElement('label')
  label.htmlFor = 'chk-'+option
  label.textContent = checkboxOptions[option]
  label.classList.add('fileinfo')
  const opt = document.createElement('div')
  opt.id = 'opt-'+option
  opt.classList.add('option')
  const chk = document.createElement('input')
  chk.id = 'chk-'+option
  chk.type = 'checkbox'
  chk.checked = diffOptions[option]
  label.appendChild(opt)
  opt.appendChild(chk)
  chk.addEventListener('change', ck => {
    diffOptions[option] = ck.target.checked
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

function clearStatus() {
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
const resetTagRegex = /\{[^\}]*\\r([^\\\}]*)[^\}]*\}/g

function stripAssTags (text: string): string {
  return text.replace(/\{[^\}]*\\p(?:0+[1-9]|[1-9]{1}\d{0,3})[^\}]*\}.*?\{[^\}]*\\p0.*?(?<!\\p1)\}|\{[^\}]*\\p(?:0+[1-9]|[1-9]{1}\d{0,3}).*$/g, '').replace(/\{[^\}]*\}/g, '').replace(/\\h/g, ' ').replace(/\s?\\n\s?/g, ' ').replace(/\s?\\N\s?/g, '\r\n')
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

function handleLines(data, options): string[] {
  const lines: string[] = []
  // TODO: sortByTime
  data.forEach(line => {
    if (line.type != 'caption') return

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

    if (options.removePosLines && /\{[^\}]*\\pos/.test(line.content)) return
    if (options.removeDrawLines && /\{[^\}]*\\p[0-9 .\-\\\}]/.test(line.content)) return

    if (options.removeEmptyLines && text.replace(/\xa0/g, ' ').trim() === '') return

    if (options.normalizeCharacters) {
      text = text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/…/g, '...')
    }

    if (options.removeSpecialCharacters) {
      text = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()…?–—]/g, '')
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

function guessGroup(filename) {
  const discordStyle = filename.match(/^([A-Za-z0-9-]+)_[A-Za-z_]+_-_(?:[Ss]\d+)?[Ee]?\d+[_.]/)
  if (discordStyle) return discordStyle[1]

  const groupBlacklist = ['xvid', 'x264', 'x265', 'avc', 'hevc', 'dvd', 'dvd5', 'dvd9', 'dvdiso', 'dvd-r', 'dvdr', 'movie', '4k', '2160p', '1080p', '720p', '576p', '480p', '2160', '1080', '720', '576', '480', 'bluray', 'bdmv', 'bdiso', 'proper', 'aac', 'ac3', 'flac', 'vob', 'ifo', 'vob ifo', 'vob.ifo', 'vob_ifo', 'avi', 'remux', 'uncut', 'dl', 'us', 'r', 'j', 'jp', 'jpn', 'ita', 'dvdrip', 'pal', 'ntsc', 'bd', 'bdremux', 'bdremux.1080p', '1080p remux', 'hd', 'eng', 'exclusive', 'japanese', 'nogrp', 'nogroup', '3d half sbs', 'r1', 'r2', 'r2j', 'extras', 'trailers', 'rifftrax', 'cd1', 'cd2'];
  const groupRegex = /^\[(?!Japanese)(?:[0-9]+[pP]?|MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|([^[\u4E00-\u9FCC¶^\]]+))\](?!\[).*|^\[(?!Japanese)(?:MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|\d{6}|([^½ \]\u4E00-\u9FCC]+))\].*|.*[a-zA-Z .\]]\[(?:.* Edition|[rR]iff[tT]rax|REMUX|PROPER|MOVIE|DVD(?:[95]|ISO|R).*|BD(?:MV|\d+)|AC3|AAC|.* DVD|[0-9]+[pP]?|.*?26[45]+.*?|[a-f0-9]{8}|[A-F0-9]{8}|.*FLAC|R2[ JFD].*|([^[)+-]+))](?:\[[0-9]+[pP]])$|.*(?:\.|[xhXH]\.?26[45] )(?:REMUX|PROPER|MOVIE|DVD(?:[95]|ISO|-?R)?|BD(?:MV|\d+)|AC3|AAC|FLAC|PAL|NTSC|XVID|DTS|DUB|[xhXH]\.?26[45]|(?![cC][dD]\d|BLURAY)([A-Z]-)?([A-Z][A-Zi0-9]+|[A-Z][a-z][A-Z]|@[a-zA-Z]{2,}))$|^(lazers|neroz)-[a-z0-9-]+$|^([a-z]{3,4}|refined|publichd)(?:-[a-z0-9-]*|(?:\.EXTRAS)?\.[a-z0-9.]*)\.?(?:2160|1080|720|480)p?$|.*(?:WEB-DL|10-bit|(?:_-_|(?:[ \d]- )(?!DTS-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|WB|[xhXH]\.?26[45]|[aA][vV][iI]|Uncut|Untouched|DVDRIP|Extras|Trailers|Copy|[rR]iff[tT]rax|[a-z]*1080p|[([]?\d+|[bB][iI]|[cC][dD]\d|([^ .\])_~]+)))\)?$|.*(?:WEB-DL|10-bit|(?:_-_|(?:-([A-Z][A-Z0-9]-)|...-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|[xhXH]\.?26[45]|Uncut|Untouched|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|([^ .\])]+)))-Exclusive\)?$|.*(?:[bB]lu-[rR]ay|WEB-DL|10-bit|(?:_-_|(?:S-([A-WYZ][A-Z0-9]?-)|[^S]-([A-Z][A-Z0-9]?-)|(FTW-)|.(?!BD-[JKR][)\]]?$).(?!3-D$).-))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|X|[xhXH]\.?26[45]|Uncut|Untouched|[mM]ovie|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|\[([A-Z]+|[a-z]+)]|((?:[A-Z]\.?)+|[^ .\])]+(?:\[\d+])?)))\)?$|.*(?:[bB]lu-[rR]ay|WEB-DL|10-bit|(?:_-_|(?:S-([A-WYZ][A-Z0-9]?-)|[^S]-([A-Z][A-Z0-9]?-)|(FTW-)|.(?!BD-[JKR][)\]]?$).(?!3-D$).-|~))(?:\d+|[0-9]+[pP]?|PROPER|OU|J(?:PN?)?|US|R|X|[xhXH]\.?26[45]|Uncut|Untouched|[mM]ovie|[a-z]*1080p|.*_3D_([A-Z]{4,})$|.*DVD(?:[95]|ISO|-?R)?|[bB][iI]|Live_In_.*|\[([A-Z]+|[a-z]+)]|((?:[A-Z]\.?)+|[^ .\])]+(?:\[\d+])?)))\)?$|^[a-z]{3}_\[(?:[0-9]+[pP]?|MOVIE|DVD(?:[95]|ISO|-?R)?|BDMV|([^[\u4E00-\u9FCC]+))\]|^([a-z]{2,3})\..*|.*?(?:\[((?:[A-Z]{3}-)?[A-Z][a-z]{3,})\]) ?\[(?:[a-f0-9]{8}|[A-F0-9]{8})]$|(?!DVD-R).*[a-zA-Z .\]]\[(?:.* Edition|[rR]iff[tT]rax|REMUX|PROPER|MOVIE|PAL|(?:PAL.)?DVD(?:[95]|ISO|R).*|BD(?:MV|\d+)|AC3|AAC|.* DVD|[0-9]+[pP]?|.*?26[45]+.*?|[a-f0-9]{8}|[A-F0-9]{8}|.*FLAC|Eng|Ita|R\d(?:J|FR)?|.*DVD\.XviD|VOB.IFO|R2[ JFD].*|EXTRAS.*|\d+p [rR]emux|.*, \d{4}|([^[)+-]+))]$|^([a-z]+)-.*(?:[0-9]+[pP]?$)|^[a-z]{2}-([a-z]{3})$|^(?:[A-Z_]|3D)+_(?:REMUX|BLURAY|([A-Zi]{2,4}HD|HD[A-Z]{4}))$|.*\d\.\d ([a-z]{4}|[A-Z][a-z]+[A-Z]+)$|.*\.\d{4}\.BDrip\.([A-Z][a-z]+[A-Z][a-z]+)$|.*(?:-AC3|\.[xX][vV][iI][dD]|\.dxva)\.([a-z0-9]+|[A-Zi0-9]+|[A-Z][a-z]+[A-Z])$|.+/g;
  const groupName = filename.replace(/\.[^/.]+$/, '').trim().replace('DTS-HD-', '-').replace(groupRegex, '$1$2$3$4$5$6$7$8$9$10$11$12$13$14$15$16$17$18$19$20$21$22$23$24$25$26$27$28$29$30$31$32$33')
  return (groupName && groupName.length > 0 && !groupBlacklist.includes(groupName.toLowerCase())) ? groupName : filename
}

function fileList() {
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
    void info.offsetWidth // restart the shake animation
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

function diffUpdate() {
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
  if (linesA.length == 0) {
    document.getElementById('diff').textContent = 'File "' + titleA + '" is empty after filtering.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  } else if (linesB.length == 0) {
    document.getElementById('diff').textContent = 'File "' + titleB + '" is empty after filtering.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  }
  const diff = difflib.unifiedDiff(linesA, linesB, {fromfile: titleA, tofile: titleB, lineterm: ''}).join('\n')
  if (diff.trim() === '') {
    document.getElementById('diff').textContent = 'No changes between ' + titleA + ' and ' + titleB + '.'
    document.getElementById('afterdiff').style.display = 'none'
    return
  }
  const diff2htmlUi = new Diff2HtmlUI(document.getElementById('diff'), diff, { matching: diffOptions.diffMatching, outputFormat: diffOptions.diffOutputFormat, drawFileList: false, fileContentToggle: false, highlight: false });
  diff2htmlUi.draw();
  document.querySelectorAll('.d2h-code-side-line, .d2h-code-line').forEach(line => {
    const oline = line.innerHTML
    let nline = oline
    if (diffOptions.ignorePunctuation) {
      nline = nline.replace(/<(?:del[^>]*|ins[^>]*)>([ .,\/#!$%\^&\*;:{}=\-_`'~()…?–—])<\/(?:del|ins)>/g, '$1')
    }
    if (diffOptions.ignoreHonorifics) {
      nline = nline.replace(/<(?:del[^>]*|ins[^>]*)>-(san|sama|kun|chan|tan|senpai|sensei|kohai|hakase|neechan|oneesan|oneesama|oneechan|onichan|onisan|obasan|oobasan|neesan|aneki|aniki|zeki|han|niichan|dono|ojosama|niisan|oniisama|ojisan|nee|nii)<\/(?:del|ins)>/g, '-$1')
    }
    nline = nline.replace(/<\/(?:del|ins)>([ .,\/#!$%\^&\*;:{}=\-_`'~()…?–—])<(?:del[^>]*|ins[^>]*)>/g, '$1').replace(/([ '])<\/(del|ins)>/g, '</$2>$1')
    if (nline != oline) line.innerHTML = nline
  })
  document.querySelectorAll('.d2h-file-side-diff:first-child .d2h-diff-tbody > tr .d2h-code-side-linenumber, .d2h-file-diff .d2h-diff-tbody > tr .d2h-code-linenumber').forEach(lineNumber => {
    lineNumber.addEventListener('click', e => {
      const line = Array.from(lineNumber.parentNode.parentNode.children).indexOf(lineNumber.parentNode)
      if (e.shiftKey) {
        const selCur = document.querySelectorAll('.d2h-file-side-diff:first-child tr.highlight, .d2h-file-diff tr.highlight')
        const selStart = selCur[0]
        if (selStart) {
          const selEnd = selCur[selCur.length - 1]
          const selStartI = Array.from(selStart.parentNode.children).indexOf(selStart)
          const selEndI = Array.from(selEnd.parentNode.children).indexOf(selEnd)
          Array.from(document.querySelector('.d2h-file-side-diff:first-child .d2h-diff-tbody, .d2h-file-diff .d2h-diff-tbody').children).slice(Math.min(line, selStartI), Math.max(line, selEndI)+1).forEach(sel => sel.classList.add('highlight'))
          if (diffOptions.diffOutputFormat === 'side-by-side') {
            Array.from(document.querySelector('.d2h-file-side-diff:last-child .d2h-diff-tbody').children).slice(Math.min(line, selStartI), Math.max(line, selEndI)+1).forEach(sel => sel.classList.add('highlight'))
          }
        }
      } else {
        const highlights = document.querySelectorAll('.d2h-diff-tbody > tr.highlight')
        highlights.forEach(l => l.classList.remove('highlight'))
        if (highlights.length === (diffOptions.diffOutputFormat === 'side-by-side' ? 2 : 1) && highlights[0] == e.target.parentNode) return
      }
      lineNumber.parentNode.classList.add('highlight')
      if (diffOptions.diffOutputFormat === 'side-by-side') {
        document.querySelector('.d2h-file-side-diff:last-child .d2h-diff-tbody').children[line].classList.add('highlight')
      }
    })
  })
  document.querySelectorAll('.d2h-file-side-diff:last-child .d2h-diff-tbody > tr .d2h-code-side-linenumber').forEach(lineNumber => {
    lineNumber.addEventListener('click', e => {
      const line = Array.from(lineNumber.parentNode.parentNode.children).indexOf(lineNumber.parentNode)
      if (e.shiftKey) {
        const selCur = document.querySelectorAll('.d2h-file-side-diff:first-child tr.highlight')
        const selStart = selCur[0]
        if (selStart) {
          const selEnd = selCur[selCur.length - 1]
          const selStartI = Array.from(selStart.parentNode.children).indexOf(selStart)
          const selEndI = Array.from(selEnd.parentNode.children).indexOf(selEnd)
          Array.from(document.querySelector('.d2h-file-side-diff:first-child .d2h-diff-tbody').children).slice(Math.min(line, selStartI), Math.max(line, selEndI)+1).forEach(sel => sel.classList.add('highlight'))
          Array.from(document.querySelector('.d2h-file-side-diff:last-child .d2h-diff-tbody').children).slice(Math.min(line, selStartI), Math.max(line, selEndI)+1).forEach(sel => sel.classList.add('highlight'))
        }
      } else {
        const highlights = document.querySelectorAll('.d2h-diff-tbody > tr.highlight')
        highlights.forEach(l => l.classList.remove('highlight'))
        if (highlights.length === (diffOptions.diffOutputFormat === 'side-by-side' ? 2 : 1) && highlights[highlights.length - 1] == e.target.parentNode) return
      }
      lineNumber.parentNode.classList.add('highlight')
      document.querySelector('.d2h-file-side-diff:first-child .d2h-diff-tbody').children[line].classList.add('highlight')
    })
  })
  document.querySelectorAll('.d2h-ins:not(.d2h-change) .d2h-code-line-ctn').forEach(emptyLine => {
    emptyLine.innerHTML = '<ins>' + emptyLine.innerHTML + '</ins>'
  })
  document.querySelectorAll('.d2h-del:not(.d2h-change) .d2h-code-line-ctn').forEach(emptyLine => {
    emptyLine.innerHTML = '<del>' + emptyLine.innerHTML + '</del>'
  })
  document.getElementById('afterdiff').style.display = 'block'
}

// Returns false if the data couldn't be parsed as subtitles (true for duplicates, which are just skipped)
function addSubtitle(filename, index, data, format=null, title=null, name=null): boolean {
  if (!title) title = guessGroup(filename)
  if (name === title) name = null
  if (name && name.includes(title) && name.includes('(')) {
    title = name
    name = null
  }

  // TODO: (specifically for clipboard) parse ASS title section

  const fileIndex = filename.match(/_(?:Track)?(\d+)\.[A-Za-z]{3}$/)
  const hash = crypto.createHash('sha1').update(data).digest('hex')

  if (diffFiles[hash]) return true

  let parsed
  try {
    if (!format) format = subsrt.detect(data)
    if (!format) return false
    parsed = subsrt.parse(data, {format: format})
  } catch (error) {
    console.error(error)
    return false
  }

  if (!parsed || parsed.length == 0) return false

  diffFiles[hash] = {
    filename: filename,
    format: format,
    data: parsed,
    styles: collectStyles(parsed),
    title: (index > 1 && Object.keys(diffFiles).some(f => diffFiles[f].title === (name ? title + ' (' + name + ')' : title)) && !name) ? title + '_' + index : (fileIndex && !name) ? title + '_' + parseInt(fileIndex[1]) : name ? title + ' (' + name + ')' : title
  }

  fileList()

  if (!diffOptions.fileA) {
    document.getElementById('file-'+hash).click()
  } else if (!diffOptions.fileB) {
    document.getElementById('file-'+hash).click()
  }
  return true
}

diffUpdate()

input.addEventListener('change', handleFiles)

document.addEventListener('paste', (e: ClipboardEvent) => {
  const paste = e.clipboardData ? e.clipboardData.getData('text') : ''
  if (paste.trim() === '') return

  if (!addSubtitle('clipboard', 0, paste, null, 'Clipboard content')) {
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
        if (!addSubtitle(filename, 0, await file.text())) failed.push(filename)
      } else if (/\.(mkv|mks)$/.test(normalized)) {
        if (await extractMkvSubtitles(file) === 0) failed.push(filename + ' (no subtitle tracks)')
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

// Reads every subtitle track out of an mkv/mks file and adds them.
// Resolves with the number of tracks added, rejects if the file can't be parsed.
function extractMkvSubtitles (file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const filename = file.name
    const fileStream = fileReaderStream(file, { chunkSize: 2 * 1024 * 1024 })
    const parser = new SubtitleParser()
    const subs = {}
    let settled = false

    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      fileStream.destroy?.()
      parser.destroy?.()
      if (error) {
        reject(error)
        return
      }

      let added = 0
      for (const index in subs) {
        const sub = subs[index]
        if (sub.type === 'ass' || sub.type === 'ssa') {
          const header = sub.header.split(/(^\[Events\](?:\s+(?!\[).*)*\s*)/m)
          header.splice(2, 0, sub.data)
          sub.data = header.join('')
        }
        const format = sub.type === 'utf8' ? 'srt' : sub.type === 'webvtt' ? 'vtt' : sub.type
        if (addSubtitle(filename, Number(index), sub.data, format, null, sub.name)) added++
      }
      resolve(added)
    }

    parser.once('tracks', tracks => {
      tracks.forEach(track => {
        subs[track.number] = {type: track.type, count: 0, name: track.name, data: '', header: track.header}
      })
      if (!tracks.length) settle() // nothing to extract, stop reading the file
    })

    parser.on('subtitle', (subtitle, trackNumber) => {
      const sub = subs[trackNumber]
      if (!sub) return
      sub.count += 1
      if (sub.type == 'utf8' || sub.type == 'webvtt') {
        sub.data += '\r\n' + sub.count
      }
      sub.data += '\r\n' + subtitle.content
    })

    parser.once('finish', () => settle())
    // Stream errors are async, a try/catch around pipe() wouldn't see them
    parser.on('error', settle)
    fileStream.on('error', settle)

    fileStream.pipe(parser)
  })
}

function formatDuration (duration) {
  duration = Math.round(duration)
  if (duration < 2) return 'few seconds'
  if (duration < 58) return duration + ' seconds'
  if (duration < 120) return '1 minute'
  if (duration < 3598) return Math.floor(duration / 60) + ' minutes'
  if (duration < 7200) return '2 hours'
  return Math.floor(duration / 3600) + ' hours'
}
