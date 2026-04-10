declare module "circomlibjs" {
  interface PoseidonField {
    toObject(element: unknown): bigint;
    e(value: bigint | number | string): unknown;
  }

  interface PoseidonHasher {
    (inputs: (number | bigint | unknown)[]): unknown;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<PoseidonHasher>;
}
