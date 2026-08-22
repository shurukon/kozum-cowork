import { fetchGitHub } from "../src/main/net/github.ts";

const urls = [
  "https://codeload.github.com/tsgx1990/openmontage-plugin/zip/refs/heads/main",
  "https://codeload.github.com/tsgx1990/openmontage-plugin/zip/HEAD",
];
for (const url of urls) {
  const response = await fetchGitHub(url);
  console.log(JSON.stringify({ url, status: response.status, statusText: response.statusText, redirected: response.redirected, finalUrl: response.url }));
  await response.arrayBuffer();
}
