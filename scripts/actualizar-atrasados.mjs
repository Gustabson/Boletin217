import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const SOURCES = [
  {
    key: "jujuy",
    name: "JUJUY",
    url: "https://www.tujugada.com.ar/tombola-jujuy-estadisticas.asp",
  },
  {
    key: "salta",
    name: "SALTA",
    url: "https://www.tujugada.com.ar/quiniela-salta-estadisticas.asp",
  },
  {
    key: "cordoba",
    name: "CORDOBA",
    url: "https://www.tujugada.com.ar/quiniela-cordoba-estadisticas.asp",
  },
  {
    key: "ciudad",
    name: "CIUDAD",
    url: "https://www.tujugada.com.ar/quiniela-nacional-estadisticas.asp",
  },
  {
    key: "provincia",
    name: "PROVINCIA",
    url: "https://www.tujugada.com.ar/quiniela-provincia-buenos-aires-estadisticas.asp",
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const READER_PREFIX = "https://r.jina.ai/";
const FORCE_READER = process.env.FORCE_READER === "1";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(scriptDir, "..", "datos.json");
const execFileAsync = promisify(execFile);

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&ntilde;/gi, "ñ")
    .replace(/&Ntilde;/g, "Ñ")
    .replace(/&aacute;/gi, "á")
    .replace(/&eacute;/gi, "é")
    .replace(/&iacute;/gi, "í")
    .replace(/&oacute;/gi, "ó")
    .replace(/&uacute;/gi, "ú")
    .replace(/&amp;/gi, "&");
}

function extractFirstFiveHeadNumbers(html, sourceName, sectionName) {
  const normalized = decodeHtmlEntities(html);
  const sectionPattern = new RegExp(
    `AMBOS\\s+MAS\\s+${sectionName.toUpperCase()}`,
    "i",
  );
  const sectionMarker = normalized.search(sectionPattern);
  if (sectionMarker < 0) {
    throw new Error(
      `${sourceName}: no se encontró "AMBOS MAS ${sectionName.toUpperCase()}"`,
    );
  }

  const section = normalized.slice(sectionMarker);
  const headMarker = section.search(/<b>\s*CABEZA\s*<\/b>/i);
  if (headMarker < 0) {
    const markdownHeadMarker = section.search(/\*{0,2}\s*CABEZA\s*\*{0,2}/i);
    if (markdownHeadMarker < 0) {
      throw new Error(`${sourceName}: no se encontró la tabla "CABEZA"`);
    }

    const markdownHead = section.slice(markdownHeadMarker);
    const markdownEnd = markdownHead.search(
      /\*{0,2}\s*A\s+LOS\s+5\s*\*{0,2}/i,
    );
    if (markdownEnd < 0) {
      throw new Error(`${sourceName}: no se encontró el final de CABEZA`);
    }

    const numericCells = [
      ...markdownHead
        .slice(0, markdownEnd)
        .matchAll(/\*\*\s*(\d+)\s*\*\*/g),
    ].map((match) => match[1]);
    const numbers = numericCells
      .filter((_, index) => index % 2 === 0)
      .slice(0, 5)
      .map((number) => number.padStart(2, "0"));

    validateNumbers(numbers, sourceName);
    return numbers;
  }

  const headSection = section.slice(headMarker);
  const nextTableMarker = headSection.search(/<b>\s*A\s+LOS\s+5\s*<\/b>/i);
  const headTable =
    nextTableMarker >= 0 ? headSection.slice(0, nextTableMarker) : headSection;

  const numbers = [];
  const numberCell =
    /<font[^>]*color=['"]?#CC0000['"]?[^>]*>[\s\S]*?<font[^>]*face=['"]?Arial narrow['"]?[^>]*size=['"]?2['"]?[^>]*>\s*(\d{1,2})\s*<\/font>/gi;

  for (const match of headTable.matchAll(numberCell)) {
    numbers.push(match[1].padStart(2, "0"));
    if (numbers.length === 5) break;
  }

  validateNumbers(numbers, sourceName);
  return numbers;
}

function validateNumbers(numbers, sourceName) {
  if (numbers.length !== 5) {
    throw new Error(
      `${sourceName}: se esperaban 5 números de CABEZA y se encontraron ${numbers.length}`,
    );
  }
  if (numbers.some((number) => !/^\d{2}$/.test(number) || Number(number) > 99)) {
    throw new Error(`${sourceName}: la fuente devolvió un número inválido`);
  }
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${sourceName}: la fuente devolvió números repetidos`);
  }
}

async function download(url, headers = []) {
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--retry",
    "3",
    "--retry-all-errors",
    "--connect-timeout",
    "15",
    "--max-time",
    "60",
    "--user-agent",
    USER_AGENT,
  ];
  for (const header of headers) {
    args.push("--header", header);
  }
  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    encoding: "buffer",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function parseSourcePage(content, source) {
  const base = {
    nombre: source.name,
    fuente: source.url,
  };
  return {
    key: source.key,
    atrasados: {
      ...base,
      numeros: extractFirstFiveHeadNumbers(content, source.name, "ATRASADOS"),
    },
    salidores: {
      ...base,
      numeros: extractFirstFiveHeadNumbers(content, source.name, "SALIDORES"),
    },
  };
}

async function fetchSourceData(source) {
  let directError = new Error("acceso directo omitido en GitHub Actions");
  if (!FORCE_READER) {
    try {
      const rawHtml = await download(source.url, [
        "Accept: text/html,application/xhtml+xml",
        "Accept-Language: es-AR,es;q=0.9",
      ]);
      return parseSourcePage(
        new TextDecoder("windows-1252").decode(rawHtml),
        source,
      );
    } catch (error) {
      directError = error;
      console.warn(
        `${source.name}: acceso directo no disponible; usando respaldo.`,
      );
    }
  }

  try {
    const readerContent = await download(`${READER_PREFIX}${source.url}`, [
      "Accept: text/plain",
      "X-No-Cache: true",
    ]);
    return parseSourcePage(
      new TextDecoder("utf-8").decode(readerContent),
      source,
    );
  } catch (readerError) {
    throw new Error(
      `${source.name}: fallaron la fuente directa (${directError.message}) y el respaldo (${readerError.message})`,
    );
  }
}

async function readExistingData() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return null;
  }
}

function sameNumbers(previous, current) {
  return ["atrasados", "salidores"].every((mode) =>
    SOURCES.every((source) => {
      const oldNumbers = previous?.[mode]?.[source.key]?.numeros;
      const newNumbers = current[mode][source.key].numeros;
      return (
        Array.isArray(oldNumbers) &&
        oldNumbers.length === newNumbers.length &&
        oldNumbers.every((number, index) => number === newNumbers[index])
      );
    }),
  );
}

async function main() {
  const results = await Promise.all(SOURCES.map(fetchSourceData));

  const data = {
    actualizado: new Date().toISOString(),
    criterio: "CABEZA > primeros 5 números",
    atrasados: Object.fromEntries(
      results.map((result) => [result.key, result.atrasados]),
    ),
    salidores: Object.fromEntries(
      results.map((result) => [result.key, result.salidores]),
    ),
  };

  const previous = await readExistingData();
  if (sameNumbers(previous, data)) {
    console.log("Sin cambios en atrasados ni salidores.");
    return;
  }

  await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Datos actualizados en ${outputPath}`);
  for (const mode of ["atrasados", "salidores"]) {
    console.log(mode.toUpperCase());
    for (const source of SOURCES) {
      console.log(
        `${source.name}: ${data[mode][source.key].numeros.join(", ")}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
