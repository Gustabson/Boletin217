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
    throw new Error(`${sourceName}: no se encontró la tabla "CABEZA"`);
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

  if (numbers.length !== 5) {
    throw new Error(
      `${sourceName}: se esperaban 5 números de CABEZA y se encontraron ${numbers.length}`,
    );
  }
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`${sourceName}: la fuente devolvió números repetidos`);
  }

  return numbers;
}

async function fetchHtml(url, sourceName) {
  try {
    const { stdout } = await execFileAsync(
      "curl",
      [
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
        "45",
        "--user-agent",
        USER_AGENT,
        "--header",
        "Accept: text/html,application/xhtml+xml",
        "--header",
        "Accept-Language: es-AR,es;q=0.9",
        url,
      ],
      {
        encoding: "buffer",
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return new TextDecoder("windows-1252").decode(stdout);
  } catch (error) {
    throw new Error(
      `${sourceName}: no se pudo descargar la página (${error.message})`,
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
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const html = await fetchHtml(source.url, source.name);
      const base = {
        nombre: source.name,
        fuente: source.url,
      };
      return {
        key: source.key,
        atrasados: {
          ...base,
          numeros: extractFirstFiveHeadNumbers(
            html,
            source.name,
            "ATRASADOS",
          ),
        },
        salidores: {
          ...base,
          numeros: extractFirstFiveHeadNumbers(
            html,
            source.name,
            "SALIDORES",
          ),
        },
      };
    }),
  );

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
