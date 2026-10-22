// Stand-in for the real work: a command that needs the API key. `testlease exec` puts the key in
// its environment; the agent that acquired the lease never sees it.
const key = process.env.TESTLEASE_SECRET_APIKEY;
if (!key) {
  console.error('TESTLEASE_SECRET_APIKEY is missing');
  process.exit(1);
}
console.log(
  `${process.env.TESTLEASE_OWNER}: calling the API with ${process.env.TESTLEASE_RESOURCE_ID} (key length ${key.length})`,
);
await new Promise((r) => setTimeout(r, 500));
