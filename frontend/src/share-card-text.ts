export type FittedCanvasText = {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  fits: boolean;
};

type FitCanvasTextOptions = {
  maxWidth: number;
  maxHeight: number;
  maxFontSize: number;
  minFontSize: number;
  lineHeightRatio: number;
  fontFamily: string;
};

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const character of Array.from(text.trim())) {
    if (character === "\n") {
      lines.push(line);
      line = "";
      lineWidth = 0;
      continue;
    }
    const characterWidth = context.measureText(character).width;
    if (line && lineWidth + characterWidth > maxWidth) {
      lines.push(line);
      line = character;
      lineWidth = characterWidth;
    } else {
      line += character;
      lineWidth += characterWidth;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

export function fitCanvasText(context: CanvasRenderingContext2D, text: string, options: FitCanvasTextOptions): FittedCanvasText {
  let last: FittedCanvasText | undefined;
  for (let fontSize = options.maxFontSize; fontSize >= options.minFontSize; fontSize -= 0.5) {
    context.font = `${fontSize}px ${options.fontFamily}`;
    const lineHeight = fontSize * options.lineHeightRatio;
    const lines = wrapCanvasText(context, text, options.maxWidth);
    last = { lines, fontSize, lineHeight, fits: lines.length * lineHeight <= options.maxHeight };
    if (last.fits) return last;
  }
  return last!;
}
