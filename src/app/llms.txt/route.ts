import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getDocPageSlugs } from "../(docs)/docs/api";
import { extractTextFromMDX } from "../api/llms-txt/ast-extract";
import index from "../(docs)/docs/index";
import { loadGuides } from "../(docs)/docs/installation/framework-guides";

export const dynamic = "force-static";
export const revalidate = false;

export async function GET() {
  let output = "Tailwind CSS Documentation\n\n";
  output +=
    "This file contains a concatenated, text-only version of all Tailwind CSS documentation pages, optimized for Large Language Model consumption.\n\n";
  output += "---\n\n";

  let slugs = await getDocPageSlugs();

  // Build a map of slugs to their section and title from the index
  let slugToSection = new Map<string, { section: string; title: string }>();
  for (let [section, entries] of Object.entries(index)) {
    for (let entry of entries) {
      let [title, docPath] = entry;
      let slug = docPath.replace("/docs/", "");
      slugToSection.set(slug, { section, title });

      // Handle nested children
      if (entry.length > 2 && Array.isArray(entry[2])) {
        for (let [childTitle, childPath] of entry[2]) {
          let childSlug = childPath.replace("/docs/", "");
          slugToSection.set(childSlug, { section, title: childTitle });
        }
      }
    }
  }

  // Process each slug in the order defined by the index
  let processedSlugs = new Set<string>();
  let currentSection = "";

  for (let [section, entries] of Object.entries(index)) {
    if (section !== currentSection) {
      if (currentSection !== "") {
        output += "\n";
      }
      output += `# ${section}\n\n`;
      currentSection = section;
    }

    for (let entry of entries) {
      let [title, docPath] = entry;
      let slug = docPath.replace("/docs/", "");

      if (processedSlugs.has(slug)) continue;
      processedSlugs.add(slug);

      output += await processSlug(slug, title);

      // Handle nested children
      if (entry.length > 2 && Array.isArray(entry[2])) {
        for (let [childTitle, childPath] of entry[2]) {
          let childSlug = childPath.replace("/docs/", "");
          if (processedSlugs.has(childSlug)) continue;
          processedSlugs.add(childSlug);
          output += await processSlug(childSlug, childTitle);
        }
      }
    }
  }

  // Process any remaining slugs that weren't in the index
  for (let slug of slugs) {
    if (!processedSlugs.has(slug)) {
      let sectionInfo = slugToSection.get(slug);
      let title = sectionInfo?.title || slug;
      output += await processSlug(slug, title);
    }
  }

  return new NextResponse(output, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": process.env.NODE_ENV === "development" ? "no-cache" : "public, max-age=3600",
    },
  });
}

async function processSlug(slug: string, title: string): Promise<string> {
  // Handle installation pages specially - they are TSX, not MDX
  if (slug === "installation") {
    return await processInstallationPages();
  }

  try {
    let filePath = path.join(process.cwd(), "./src/docs", `${slug}.mdx`);
    let content = await fs.readFile(filePath, "utf8");

    // Extract title and description from exports
    let titleMatch = content.match(/export\s+const\s+title\s*=\s*["']([^"']+)["']/);
    let descriptionMatch = content.match(/export\s+const\s+description\s*=\s*["']([^"']+)["']/);

    let pageTitle = titleMatch ? titleMatch[1] : title;
    let description = descriptionMatch ? descriptionMatch[1] : "";

    // Extract text from MDX
    let extractedText = extractTextFromMDX(content);

    // Remove the title/description header that extractTextFromMDX adds (we'll format it ourselves)
    if (extractedText.startsWith("# ")) {
      let lines = extractedText.split("\n");
      // Skip the title line, description line(s), and separator
      let startIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("---")) {
          startIndex = i + 1;
          break;
        }
      }
      extractedText = lines.slice(startIndex).join("\n").trim();
    }

    // Downgrade the headings in extractedText by one level (# -> ##, ## -> ###, etc.) to maintain the hierarchy of the document structure
    extractedText = extractedText.replace(/^#{1,6}\s/gm, (match) => {
      return "#" + match; // Add an extra # before each heading to downgrade it
    });

    // Format the page
    let pageOutput = `## ${pageTitle}\n\n`;
    if (description) {
      pageOutput += `${description}\n\n`;
    }
    pageOutput += `URL: /docs/${slug}\n\n`;
    pageOutput += `${extractedText}\n\n`;
    pageOutput += "---\n\n";

    return pageOutput;
  } catch (error) {
    console.error(`Error processing ${slug}:`, error);
    return "";
  }
}

// --- Installation page extraction ---

let INSTALLATION_TABS = [
  { slug: "using-vite", file: "using-vite/page.tsx" },
  { slug: "using-postcss", file: "using-postcss/page.tsx" },
  { slug: "tailwind-cli", file: "tailwind-cli/page.tsx" },
  { slug: "play-cdn", file: "play-cdn/page.tsx" },
];

async function processInstallationPages(): Promise<string> {
  let output = "";

  // Process each installation tab page
  for (let tab of INSTALLATION_TABS) {
    let filePath = path.join(
      process.cwd(),
      "src/app/(docs)/docs/installation/(tabs)",
      tab.file,
    );
    try {
      let content = await fs.readFile(filePath, "utf8");
      output += extractInstallationPageText(content, tab.slug);
    } catch (e) {
      console.error(`Error reading installation page ${tab.slug}:`, e);
    }
  }

  // Process framework guides
  output += await processFrameworkGuides();

  return output;
}

function extractInstallationPageText(source: string, slug: string): string {
  // Extract metadata title and description
  let titleMatch = source.match(/title:\s*["']([^"']+)["']/);
  let descMatch = source.match(/description:\s*\n?\s*["']([^"']+)["']/);
  let pageTitle = titleMatch ? titleMatch[1] : slug;
  let description = descMatch ? descMatch[1] : "";

  let output = `## ${pageTitle}\n\n`;
  if (description) {
    output += `${description}\n\n`;
  }
  output += `URL: /docs/installation/${slug}\n\n`;

  // Extract steps
  let steps = extractStepsFromTSX(source);
  for (let i = 0; i < steps.length; i++) {
    let step = steps[i];
    output += `### Step ${i + 1}: ${step.title}\n\n`;
    if (step.body) {
      output += `${step.body}\n\n`;
    }
    if (step.code) {
      output += `\`\`\`${step.lang}\n${step.code}\n\`\`\`\n\n`;
    }
  }

  output += "---\n\n";
  return output;
}

interface ExtractedStep {
  title: string;
  body: string;
  code: string;
  lang: string;
  tabs?: string[];
}

function extractStepsFromTSX(source: string): ExtractedStep[] {
  let steps: ExtractedStep[] = [];

  // Only search within the steps array to avoid matching metadata title
  let stepsArrayStart = source.search(/(?:const|let|var)\s+steps\b/);
  if (stepsArrayStart === -1) stepsArrayStart = 0;
  let stepsSource = source.substring(stepsArrayStart);

  // Find all step blocks by matching the { title: "..." pattern  
  let stepRegex = /\{\s*(?:tabs:\s*\[([^\]]*)\],\s*)?title:\s*["']([^"']+)["']/g;
  let stepMatches = [...stepsSource.matchAll(stepRegex)];

  for (let i = 0; i < stepMatches.length; i++) {
    let match = stepMatches[i];
    let tabs = match[1] ? match[1].replace(/["']/g, "").split(",").map((s) => s.trim()) : undefined;
    let title = match[2];

    // Get the text between this step and the next one (or end of steps array)
    let startPos = match.index! + match[0].length;
    let endPos = i < stepMatches.length - 1 ? stepMatches[i + 1].index! : stepsSource.length;
    let stepContent = stepsSource.substring(startPos, endPos);

    // Extract body text from JSX - get content between body: ( and ),
    let body = extractBodyText(stepContent);

    // Extract code - handle both tagged template literals and nested code objects
    // Framework guides use: code: shell`...` or js`...` etc.
    // Tab pages use: code: { name: "...", lang: "...", code: dedent`...` }
    let codeMatch = stepContent.match(
      /(?:^|\s)code:\s*(?:(?:shell|js|css|html|astro|twig|elixir|handlebars|dedent)`([\s\S]*?)`)/m,
    );
    if (!codeMatch) {
      // Try to match the inner code field: code: dedent`...`
      codeMatch = stepContent.match(/\bcode:\s*dedent`([\s\S]*?)`/);
    }
    let langMatch = stepContent.match(/lang:\s*["']([^"']+)["']/);
    let code = "";
    if (codeMatch) {
      code = codeMatch[1] || "";
    }
    let lang = langMatch ? langMatch[1] : "";

    // Dedent first (before trim, to preserve relative indentation), then clean
    code = dedentString(code);
    code = cleanCodeAnnotations(code);

    steps.push({ title, body, code, lang, tabs });
  }

  return steps;
}

function extractBodyText(content: string): string {
  // Match body: ( ... ), or body: <p>...</p>,
  let bodyMatch = content.match(/body:\s*\(\s*([\s\S]*?)\s*\)\s*,/);
  if (!bodyMatch) {
    bodyMatch = content.match(/body:\s*(<p>[\s\S]*?<\/p>)\s*,/);
  }
  if (!bodyMatch) return "";

  let jsx = bodyMatch[1];

  // Remove JSX tags but keep text content
  let text = jsx
    .replace(/\{" "\}/g, " ")
    .replace(/\{"([^"]+)"\}/g, (_, content) => content.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace(/<code>/g, "`")
    .replace(/<\/code>/g, "`")
    .replace(/<a\s+href="([^"]+)">/g, "")
    .replace(/<\/a>/g, "")
    .replace(/<\/?p>/g, "")
    .replace(/<\/?em>/g, "")
    .replace(/<\/?strong>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<Link\s+href="([^"]+)">/g, "")
    .replace(/<\/Link>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function dedentString(text: string): string {
  let lines = text.split("\n");
  // Find minimum indentation (ignoring empty lines)
  let minIndent = Infinity;
  for (let line of lines) {
    if (line.trim().length === 0) continue;
    let indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity || minIndent === 0) return text;
  return lines.map((line) => line.substring(minIndent)).join("\n");
}

function cleanCodeAnnotations(code: string): string {
  let cleaned = code
    .split("\n")
    .map((line) => {
      let original = line;
      line = line.replace(/<!--\s*\[!code[^\]]+\]\s*-->/g, "");
      line = line.replace(/\/\*\s*\[!code[^\]]+\]\s*\*\//g, "");
      line = line.replace(/#\s*\[!code[^\]]+\]/g, "");
      line = line.replace(/\/\/\s*\[!code[^\]]+\]/g, "");
      line = line.replace(/\[!code[^\]]+\]/g, "");
      // If the line was only an annotation (now empty/whitespace), mark it
      if (original.trim().length > 0 && line.trim().length === 0) {
        return null; // Mark for removal
      }
      return line;
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .trim();
  // Collapse multiple consecutive blank lines into one
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

async function processFrameworkGuides(): Promise<string> {
  let output = "";

  try {
    let guides = await loadGuides();

    for (let guide of guides) {
      let pageTitle = guide.page.title;
      let description = guide.page.description;
      let slug = guide.slug;

      // Determine URL based on tabs
      let hasTabs = guide.tabs && guide.tabs.length > 0;

      if (hasTabs) {
        // For guides with tabs, generate a separate page for each tab
        for (let tab of guide.tabs!) {
          let tabSlug = `${slug}/${tab.slug}`;
          output += `## ${pageTitle} (${tab.title})\n\n`;
          if (description) {
            output += `${description}\n\n`;
          }
          output += `URL: /docs/installation/framework-guides/${tabSlug}\n\n`;

          // Filter steps for this tab
          let tabSteps = guide.steps.filter(
            (step) => !step.tabs || step.tabs.includes(tab.slug),
          );

          for (let i = 0; i < tabSteps.length; i++) {
            let step = tabSteps[i];
            output += `### Step ${i + 1}: ${step.title}\n\n`;
            let bodyText = extractBodyFromJSX(step.body);
            if (bodyText) {
              output += `${bodyText}\n\n`;
            }
            if (step.code && step.code.code) {
              let code = cleanCodeAnnotations(step.code.code);
              output += `\`\`\`${step.code.lang}\n${code}\n\`\`\`\n\n`;
            }
          }

          output += "---\n\n";
        }
      } else {
        output += `## ${pageTitle}\n\n`;
        if (description) {
          output += `${description}\n\n`;
        }
        output += `URL: /docs/installation/framework-guides/${slug}\n\n`;

        for (let i = 0; i < guide.steps.length; i++) {
          let step = guide.steps[i];
          output += `### Step ${i + 1}: ${step.title}\n\n`;
          let bodyText = extractBodyFromJSX(step.body);
          if (bodyText) {
            output += `${bodyText}\n\n`;
          }
          if (step.code && step.code.code) {
            let code = cleanCodeAnnotations(step.code.code);
            output += `\`\`\`${step.code.lang}\n${code}\n\`\`\`\n\n`;
          }
        }

        output += "---\n\n";
      }
    }
  } catch (error) {
    console.error("Error processing framework guides:", error);
  }

  return output;
}

function extractBodyFromJSX(body: any): string {
  if (!body) return "";

  // If it's a React element, try to extract text from its props
  if (typeof body === "object" && body !== null) {
    return extractTextFromReactElement(body);
  }

  if (typeof body === "string") return body;
  return "";
}

function extractTextFromReactElement(element: any): string {
  if (!element) return "";
  if (typeof element === "string") return element;
  if (typeof element === "number") return String(element);

  // React element
  if (element.props) {
    let children = element.props.children;
    if (!children) return "";

    if (typeof children === "string") {
      return children;
    }

    if (Array.isArray(children)) {
      return children
        .map((child: any) => {
          if (typeof child === "string") return child;
          if (typeof child === "number") return String(child);
          if (typeof child === "object" && child !== null) {
            // Handle <code> elements
            if (child.type === "code" && child.props?.children) {
              return `\`${child.props.children}\``;
            }
            return extractTextFromReactElement(child);
          }
          return "";
        })
        .join("");
    }

    if (typeof children === "object") {
      return extractTextFromReactElement(children);
    }
  }

  return "";
}
