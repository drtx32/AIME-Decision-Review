// Module declarations for npm packages that ship without TypeScript types.
declare module "adm-zip" {
  class AdmZip {
    constructor(input?: Buffer | Uint8Array | string);
    getEntry(name: string): IZipEntry | null;
    getEntries(): IZipEntry[];
    readFile(name: string): Buffer | null;
    addFile(name: string, content: Buffer | string): void;
    toBuffer(): Buffer;
  }
  interface IZipEntry {
    getData(): Buffer;
    entryName: string;
  }
  export = AdmZip;
}

declare module "pdf-parse" {
  type PdfParseFn = (
    data: Buffer,
    options?: Record<string, unknown>
  ) => Promise<{ text: string; numpages?: number; info?: unknown }>;
  const pdfParse: PdfParseFn;
  export default pdfParse;
}