import type { WordTimestamp } from "./schemas.js";

export const STORY_TOKENIZER_VERSION = "story-tokenizer/1" as const;

/** 稳定拆分旁白引用词元：汉字逐字，连续拉丁字母/数字作为一个词元，控制标签与标点不计入。 */
export function tokenizeNarration(text: string): string[] {
    const cleaned = stripSpeechControls(text).normalize("NFKC");
    const tokens: string[] = [];
    let buffered = "";
    const flush = () => {
        if (buffered) tokens.push(buffered);
        buffered = "";
    };
    for (const character of cleaned) {
        if (isHan(character)) {
            flush();
            tokens.push(character);
        } else if (/[\p{L}\p{N}._+-]/u.test(character)) {
            buffered += character;
        } else {
            flush();
        }
    }
    flush();
    return tokens.filter((token) => /[\p{L}\p{N}]/u.test(token));
}

/**
 * 将 Provider 或本地对齐器的任意分词结果映射回稳定词元。
 * 每个源词内部按字符比例插值，确保两种对齐来源产生相同的 token 索引。
 */
export function retimeToNarrationTokens(sourceText: string, alignedWords: WordTimestamp[]): WordTimestamp[] {
    const tokens = tokenizeNarration(sourceText);
    const sourceCharacters = tokens.flatMap((token, tokenIndex) =>
        [...comparableText(token)].map((character) => ({ character, tokenIndex })));
    const timedCharacters = alignedWords.flatMap((word) => {
        const characters = [...comparableText(word.text)];
        if (characters.length === 0) return [];
        const duration = word.end_sample - word.start_sample;
        return characters.map((character, characterIndex) => ({
            character,
            start: word.start_sample + Math.floor(duration * characterIndex / characters.length),
            end: word.start_sample + Math.ceil(duration * (characterIndex + 1) / characters.length),
        }));
    });
    if (sourceCharacters.length === 0 || timedCharacters.length === 0) return [];

    const mapped = new Map<number, Array<{ start: number; end: number }>>();
    let timedIndex = 0;
    for (const source of sourceCharacters) {
        const foundIndex = findNextCharacter(timedCharacters, source.character, timedIndex);
        if (foundIndex < 0) continue;
        const timing = timedCharacters[foundIndex];
        const values = mapped.get(source.tokenIndex) || [];
        values.push({ start: timing.start, end: timing.end });
        mapped.set(source.tokenIndex, values);
        timedIndex = foundIndex + 1;
    }

    const output = tokens.map((text, index) => {
        const timings = mapped.get(index);
        if (timings?.length) {
            return {
                index,
                text,
                start_sample: timings[0].start,
                end_sample: timings[timings.length - 1].end,
            };
        }
        return interpolateMissingToken(index, text, mapped, tokens.length, alignedWords);
    });
    for (let index = 1; index < output.length; index += 1) {
        output[index].start_sample = Math.max(output[index].start_sample, output[index - 1].start_sample);
        output[index].end_sample = Math.max(output[index].start_sample + 1, output[index].end_sample);
    }
    return output;
}

export function stripSpeechControls(text: string) {
    return text
        .replace(/<#[0-9]+(?:\.[0-9]+)?#>/g, "")
        .replace(/\((?:breath|sighs|laughs|cough|sniffs?|groans?)\)/gi, "");
}

function comparableText(value: string) {
    return stripSpeechControls(value)
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[\p{P}\p{S}\s]/gu, "");
}

function isHan(character: string) {
    return /\p{Script=Han}/u.test(character);
}

function findNextCharacter(
    values: Array<{ character: string }>,
    character: string,
    fromIndex: number,
) {
    for (let index = fromIndex; index < values.length; index += 1) {
        if (values[index].character === character) return index;
    }
    return -1;
}

function interpolateMissingToken(
    index: number,
    text: string,
    mapped: Map<number, Array<{ start: number; end: number }>>,
    tokenCount: number,
    alignedWords: WordTimestamp[],
): WordTimestamp {
    const previous = findMappedToken(mapped, index - 1, -1);
    const next = findMappedToken(mapped, index + 1, 1, tokenCount);
    const audioStart = alignedWords[0]?.start_sample ?? 0;
    const audioEnd = alignedWords.at(-1)?.end_sample ?? audioStart + 1;
    const start = previous?.at(-1)?.end
        ?? (next?.[0].start !== undefined ? Math.max(audioStart, next[0].start - 1) : audioStart);
    const end = next?.[0].start
        ?? (previous?.at(-1)?.end !== undefined ? Math.min(audioEnd, previous.at(-1)!.end + 1) : audioEnd);
    return {
        index,
        text,
        start_sample: Math.max(0, Math.min(start, audioEnd - 1)),
        end_sample: Math.max(start + 1, end),
    };
}

function findMappedToken(
    mapped: Map<number, Array<{ start: number; end: number }>>,
    startIndex: number,
    direction: -1 | 1,
    tokenCount = Number.POSITIVE_INFINITY,
) {
    for (let index = startIndex; index >= 0 && index < tokenCount; index += direction) {
        const value = mapped.get(index);
        if (value?.length) return value;
    }
    return undefined;
}
