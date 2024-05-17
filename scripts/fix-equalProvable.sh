PATCH_CONTENT="
export function equalProvable(received, expected) {
    expect(received).toHaveLength(expected.length);
    const receivedBigInts = received.map((f) => f.toBigInt());
    const expectedBigInts = expected.map((f) => f.toBigInt());
    const pass = receivedBigInts.every((v, index) => v === expectedBigInts[index]);
    return {
        message: () => \`Expected ${expectedBigInts}, received ${receivedBigInts}\`,
        pass,
    };
}
"
echo "$PATCH_CONTENT" > "packages/common/dist/test/equalProvable.js"