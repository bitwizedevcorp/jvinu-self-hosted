declare module "snappyjs" {
  /** Decompresses a raw Snappy block. */
  export function uncompress<T extends ArrayBuffer | Uint8Array>(compressed: T, maxLength?: number): T;
  export function compress<T extends ArrayBuffer | Uint8Array>(uncompressed: T): T;
  const SnappyJS: { uncompress: typeof uncompress; compress: typeof compress };
  export default SnappyJS;
}
