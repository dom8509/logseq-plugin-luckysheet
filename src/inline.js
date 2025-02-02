import { bufferKey, range, UUIDS } from "./utils"

const idRef = { current: frameElement.dataset.id }
const { name, uuid, frame } = frameElement.dataset
const refUuid = (() => {
  const blockParent = frameElement.closest(
    ".block-content.inline",
  ).parentElement
  if (blockParent.classList.contains("block-ref")) {
    return blockParent.closest(".block-content.inline").getAttribute("blockid")
  }
  return null
})()
const pluginWindow = parent.document.getElementById(frame).contentWindow
const { logseq, t, saveBufferedFiles } = pluginWindow

const SAVE_DELAY = 3_000 // 3s
const TOOLBAR_HEIGHT = 48

let saveTimer
let workbookReady = false

async function main() {
  const title = document.getElementById("title")
  title.innerText = name
  title.title = name
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      title.blur()
    }
  })
  title.addEventListener("blur", (e) => {
    renameWorkbook(title.innerText)
  })

  const copyBtn = document.getElementById("copyBtn")
  copyBtn.title = t("Copy selection as TSV")
  copyBtn.addEventListener("click", (e) => {
    copyAsTSV()
  })

  const syncBtn = document.getElementById("syncBtn")
  syncBtn.title = t("Generate Markdown and override parent block")
  syncBtn.addEventListener("click", (e) => {
    generateAndOverrideParent()
  })

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rect = entry.target.getBoundingClientRect()
      frameElement.style.top = `${rect.top - TOOLBAR_HEIGHT}px`
      frameElement.style.left = `${rect.left}px`
      frameElement.style.width = `${rect.width}px`
      frameElement.style.height = `${rect.height + TOOLBAR_HEIGHT}px`
    }
  })

  const fullscreenBtn = document.getElementById("fullscreenBtn")
  fullscreenBtn.title = t("FullScreen Edit")
  fullscreenBtn.addEventListener("click", async (e) => {
    const container = frameElement.closest(
      "#main-content-container, .sidebar-item-list",
    )
    frameElement.classList.toggle("kef-sheet-fullscreen")
    if (frameElement.classList.contains("kef-sheet-fullscreen")) {
      if (parent.document.documentElement.classList.contains("is-mac")) {
        document.documentElement.classList.add("fullscreen-mac")
      }
      resizeObserver.observe(container)
      document.querySelector(".luckysheet-cell-input.editable")?.focus()
    } else {
      resizeObserver.unobserve(container)
      frameElement.style.top = ""
      frameElement.style.left = ""
      frameElement.style.width = ""
      frameElement.style.height = ""
      document.documentElement.classList.remove("fullscreen-mac")
    }
  })

  const saveBtn = document.getElementById("saveBtn")
  saveBtn.title = t("Save")
  saveBtn.addEventListener("click", async (e) => {
    await save()
    await saveBufferedFiles()
    logseq.UI.showMsg(t('"${name}" saved.', { name }))
  })

  const editBtn = document.getElementById("editBtn")
  editBtn.title = t("Edit block")
  editBtn.addEventListener("click", (e) => {
    logseq.Editor.editBlock(refUuid || uuid)
  })

  const deleteBtn = document.getElementById("deleteBtn")
  deleteBtn.title = t("Delete spreadsheet")
  deleteBtn.addEventListener("click", (e) => {
    promptToDelete()
  })

  window.addEventListener("pagehide", (e) => {
    if (workbookReady) {
      clearTimeout(saveTimer)
      save()
    }
    resizeObserver.disconnect()
  })

  try {
    const [justCreated, data] = await read()
    if (justCreated) {
      const dataBlock = await logseq.Editor.insertBlock(
        uuid,
        `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
        { sibling: false },
      )
      // HACK: need to wait a cycle for exit editing to work.
      // Posterior block updates will fail if editing mode is not
      // exited first.
      setTimeout(async () => {
        await logseq.Editor.exitEditingMode()
        await logseq.Editor.setBlockCollapsed(uuid, true)
      }, 0)
    }
    luckysheet.create({
      container: "sheet",
      lang: t("en"),
      plugins: ["chart"],
      enableAddRow: false,
      enableAddBackTop: false,
      showinfobar: false,
      showtoolbarConfig: {
        print: false,
      },
      row: 30,
      column: 20,
      gridKey: idRef.current,
      data,
      hook: {
        workbookCreateAfter() {
          workbookReady = true

          // HACK workaround Luckysheet issue that on first focus it scrolls to
          // the top of the page.
          const editable = document.querySelector(
            ".luckysheet-cell-input.editable",
          )
          editable.addEventListener("focus", (e) => {
            pluginWindow.justFocused = true
          })

          luckysheet.setRangeShow("A1", { show: false })
        },
        updated(op) {
          clearTimeout(saveTimer)
          saveTimer = setTimeout(save, SAVE_DELAY)
        },
      },
    })
  } catch (err) {
    document.getElementById("sheet").innerHTML = `<p class="error">${t(
      "Data read error!",
    )}</p>`
  }
}

async function read() {
  const bufferedData = localStorage.getItem(bufferKey(uuid))
  if (bufferedData) {
    return [
      false,
      JSON.parse(bufferedData.substring(7, bufferedData.lastIndexOf("]") + 1)),
    ]
  }

  const firstChild = (
    await logseq.Editor.getBlock(uuid, {
      includeChildren: true,
    })
  )?.children?.[0]

  if (!firstChild?.content.startsWith("```json")) {
    const file = (await logseq.FileStorage.hasItem(idRef.current))
      ? JSON.parse(await logseq.FileStorage.getItem(idRef.current))
      : {
          data: [
            {
              name: "Sheet1",
              color: "",
              status: "1",
              order: "0",
              data: [],
              config: {},
              index: 0,
            },
          ],
        }
    return [true, Array.isArray(file) ? file : file.data]
  }

  return [
    false,
    JSON.parse(
      firstChild.content.substring(7, firstChild.content.lastIndexOf("]") + 1),
    ),
  ]
}

async function save() {
  const sheets = luckysheet.getAllSheets()
  for (const sheet of sheets) {
    // Do not save selections.
    sheet.luckysheet_selection_range = []

    // Process charts
    if (sheet.chart) {
      for (const chart of sheet.chart) {
        const div = document.getElementById(`${chart.chart_id}_c`)
        if (div.style) {
          chart.left = parseInt(div.style.left)
          chart.top = parseInt(div.style.top)
          chart.width = parseInt(div.style.width)
          chart.height = parseInt(div.style.height)
        }
        chart.chartOptions = {
          ...chartmix.default.getChartJson(chart.chart_id),
        }
      }
    }
  }

  const data = `\`\`\`json\n${JSON.stringify(sheets)}\n\`\`\``
  localStorage.setItem(bufferKey(uuid), data)
  localStorage.setItem(UUIDS, `${localStorage.getItem(UUIDS) ?? ""}${uuid},`)
}

async function copyAsTSV() {
  const data = luckysheet.getRangeArray("twoDimensional")
  const text = data.map((row) => row.join("\t")).join("\n")
  await navigator.clipboard.writeText(text)

  logseq.UI.showMsg(t("Selection copied"))
}

async function generateAndOverrideParent() {
  const block = await logseq.Editor.getBlock(refUuid || uuid)
  if (block.parent != null && block.parent.id !== block.page.id) {
    const parent = await logseq.Editor.getBlock(block.parent.id)
    const markdown = generateMarkdown()
    await logseq.Editor.updateBlock(parent.uuid, markdown)
  } else {
    logseq.UI.showMsg(t("Luckysheet needs to have a parent block"))
  }
}

function generateMarkdown() {
  const data = luckysheet.getSheetData()
  const rowLength = data.length
  const columnLength = data[0].length

  let rowStart = Math.max(
    0,
    data.findIndex((row) => row.some((cell) => cell != null)),
  )
  let colStart = Math.max(
    0,
    range(columnLength).findIndex((c) => {
      for (let r = 0; r < rowLength; r++) {
        if (data[r][c] != null) return true
      }
      return false
    }),
  )
  let colEnd = 0
  for (let i = colStart + 1; i < data[rowStart].length; i++) {
    if (
      data[rowStart][i]?.m == null &&
      data[rowStart][i]?.ct?.t !== "inlineStr"
    ) {
      colEnd = i
      break
    }
  }

  const rows = []
  for (let i = rowStart; i < data.length; i++) {
    const row = new Array(colEnd - colStart)

    for (let j = colStart; j < colEnd; j++) {
      const cell = data[i][j]
      if (cell?.m != null || cell?.ct?.t === "inlineStr") {
        row[j - colStart] =
          cell?.m != null
            ? `${cell.bl ? "**" : ""}${cell.cl ? "~~" : ""}${
                cell.it ? "_" : ""
              }${cell.m}${cell.it ? "_" : ""}${cell.cl ? "~~" : ""}${
                cell.bl ? "**" : ""
              }`
            : cell?.ct.s
                .map(({ bl, it, cl, v }) => {
                  const lines = v.split("\r\n")
                  return lines
                    .map(
                      (line) =>
                        `${bl ? "**" : ""}${cl ? "~~" : ""}${
                          it ? "_" : ""
                        }${line}${it ? "_" : ""}${cl ? "~~" : ""}${
                          bl ? "**" : ""
                        }`,
                    )
                    .join(" [:br]")
                })
                .join("")
                .trim()
      }
    }

    if (row.every((cell) => !cell)) break

    rows.push(`| ${row.join(" | ")} |`)

    if (i === 0) {
      rows.push(
        `| ${row
          .map((_, j) => {
            switch (data[i][j]?.ht) {
              case "0":
                return ":---:"
              case "2":
                return "---:"
              default:
                return "---"
            }
          })
          .join(" | ")} |`,
      )
    }
  }

  return rows.join("\n")
}

async function renameWorkbook(newName) {
  const block = await logseq.Editor.getBlock(uuid)
  await logseq.Editor.updateBlock(
    uuid,
    block.content.replace(
      new RegExp(`{{renderer :luckysheet,\\s*${name}\\s*}}`, "i"),
      `{{renderer :luckysheet, ${newName}}}`,
    ),
  )
}

async function promptToDelete() {
  const ok = parent.window.confirm(t('You sure to delete "${name}"?', { name }))
  if (!ok) return

  clearTimeout(saveTimer)
  const block = await logseq.Editor.getBlock(uuid, { includeChildren: true })
  if ((block.children?.length ?? 0) <= 1) {
    await logseq.Editor.removeBlock(uuid)
  } else if (block.children[0].content.startsWith("```json")) {
    await logseq.Editor.updateBlock(uuid, "")
    await logseq.Editor.removeBlock(block.children[0].uuid)
  }
  workbookReady = false
}

main()
