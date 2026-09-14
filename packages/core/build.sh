cd "$(dirname "$0")"

rm -rf dist

npx tsc -p tsconfig.esm.json
npx tsc -p tsconfig.cjs.json

echo '{"type":"module"}' > dist/esm/package.json
echo '{"type":"commonjs"}' > dist/cjs/package.json