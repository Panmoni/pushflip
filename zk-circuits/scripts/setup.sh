#!/bin/bash
set -euo pipefail

# Trusted setup for the shuffle_verify circuit
# This uses a test-only ceremony. Production requires a real MPC ceremony.

BUILD_DIR="build"
CIRCUIT="shuffle_verify"
PTAU_SIZE=18  # 2^18 = 262144 constraints (enough for ~120K)

echo "=== Phase 1: Powers of Tau ==="
if [ ! -f "$BUILD_DIR/pot${PTAU_SIZE}_0001.ptau" ]; then
    snarkjs powersoftau new bn128 $PTAU_SIZE "$BUILD_DIR/pot${PTAU_SIZE}_0000.ptau" -v
    snarkjs powersoftau contribute "$BUILD_DIR/pot${PTAU_SIZE}_0000.ptau" "$BUILD_DIR/pot${PTAU_SIZE}_0001.ptau" \
        --name="test contribution" -v -e="random entropy for test"
    snarkjs powersoftau prepare phase2 "$BUILD_DIR/pot${PTAU_SIZE}_0001.ptau" "$BUILD_DIR/pot${PTAU_SIZE}_final.ptau" -v
    echo "Powers of Tau complete"
else
    echo "Powers of Tau already exists, skipping"
fi

echo ""
echo "=== Phase 2: Circuit-specific setup ==="
snarkjs groth16 setup "$BUILD_DIR/${CIRCUIT}.r1cs" "$BUILD_DIR/pot${PTAU_SIZE}_final.ptau" "$BUILD_DIR/${CIRCUIT}_0000.zkey"
snarkjs zkey contribute "$BUILD_DIR/${CIRCUIT}_0000.zkey" "$BUILD_DIR/${CIRCUIT}_final.zkey" \
    --name="test contribution" -v -e="more random entropy"
snarkjs zkey export verificationkey "$BUILD_DIR/${CIRCUIT}_final.zkey" "$BUILD_DIR/verification_key.json"

echo ""
echo "=== Setup complete ==="
echo "Verification key: $BUILD_DIR/verification_key.json"
echo "Proving key: $BUILD_DIR/${CIRCUIT}_final.zkey"
ls -lh "$BUILD_DIR/${CIRCUIT}_final.zkey" "$BUILD_DIR/verification_key.json"
