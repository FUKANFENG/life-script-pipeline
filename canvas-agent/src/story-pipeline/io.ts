import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(directoryPath: string) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

export function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function writeJsonAtomic(filePath: string, value: unknown) {
    writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeFileAtomic(filePath: string, value: string | Uint8Array) {
    ensureDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, value);
    replaceFile(temporaryPath, filePath);
}

export function replaceFile(sourcePath: string, destinationPath: string) {
    if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath);
    fs.renameSync(sourcePath, destinationPath);
}

export function relativeProjectPath(projectDirectory: string, filePath: string) {
    const relative = path.relative(projectDirectory, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`产物路径不在项目目录内：${filePath}`);
    }
    return relative.split(path.sep).join("/");
}
