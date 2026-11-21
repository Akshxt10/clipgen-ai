# Creator authorization — how ClipGen AI can clip a video without downloading it from YouTube

## The limitation (and why it cannot be engineered around)

* YouTube's Terms of Service say nobody may access, reproduce or download videos "except as specifically permitted
  by the Service" or with YouTube's written permission. A creator's licence to other users applies only "as enabled
  by a feature of the Service".
* The YouTube Data API has **no endpoint that returns video or audio**, and the API Services terms give no right to
  copy audiovisual content outside the API services.
* Therefore a creator approving clipping — on YouTube, in a description, or in ClipGen AI — **cannot** make a
  download from YouTube legitimate, and ClipGen AI does not attempt one: no yt-dlp, no scraping, no unofficial APIs,
  no downloader sites, no capturing the embedded player.

So a YouTube link alone can never become a clip automatically. What *can* be automatic is this: the creator gives
ClipGen AI **their own original file from their own storage**, and ClipGen AI can prove it is the file they approved.

## How it works

1. **Register once.** In *Creator Studio* the creator makes a signing key (in the browser), enters channel name,
   handle and where they will publish their manifest, and gets a *registration request* plus a verification code.
2. **Maintainer verifies.** The ClipGen maintainer checks the code appears in the channel's About text (proof the
   registrant controls the channel) and adds the entry to `registry/creators.json` with `"status": "verified"` and
   `verification: {method, verifiedAt}`. Nothing is processed for a creator before that. The registry ships empty.
3. **Approve videos.** In Creator Studio the creator adds each video: link, original file (fingerprinted with
   SHA-256 in the browser, not uploaded), the public https address of that file, and terms (captions, 9:16 export,
   attribution). Studio signs the manifest. The creator publishes the manifest file and the original files on a host
   they control.
4. **Viewer pastes a link.** ClipGen AI finds the video's author (YouTube oEmbed), looks them up in the registry,
   loads their manifest, checks every step (below), downloads the file from the creator's host while hashing it,
   and keeps it only if size and SHA-256 equal the signed values. No checkbox is shown for a verified source.

### What "Verified" means — all must be true
registry loaded · creator listed · status `verified` (maintainer) · YouTube's author matches the registered channel
(or, if YouTube could not be asked, it is labelled **unconfirmed**) · manifest fetched · signature valid for the
registered key · key ID matches · manifest creator ID matches · not expired · this video listed · clipping allowed ·
file size and SHA-256 equal the signed values. Any failure → "Not verified" with the exact reason and what is needed.

### What it never does
Treat a description, comment, public statement or checkbox as permission · download from YouTube · show a creator
as verified when the registry says `pending` or `revoked` · keep a file that fails its hash.

### Revocation
Set the registry entry to `revoked` (or remove the video from the manifest / let it expire). Every time a project
opens, the approval is checked again; a revoked or invalid approval blocks the project (video hidden, analysis off).
If the registry or host is only unreachable, the project keeps working and says it could not re-check.

## Requirements for the creator's host
* Any free or paid file host the creator controls (own site, cloud storage with public links…) with **https**.
* It must send `Access-Control-Allow-Origin` for ClipGen AI's origin (or `*`), otherwise browsers block the
  download and ClipGen AI says so. Not every storage service offers this; check before relying on it.
* MP4 or MOV; the signed size and SHA-256 must match the served file exactly.

## Registry entry (what the maintainer adds)
```json
{ "id": "my-channel", "displayName": "My Channel", "status": "verified",
  "channel": { "handle": "@mychannel", "channelId": "UC…optional but exact" },
  "keyId": "<64 hex>", "publicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "manifestUrl": "https://example.com/clipgen-manifest.json",
  "verification": { "method": "channel-code", "verifiedAt": "2026-11-21" } }
```
Studio's step 4 (“Check”) runs the same validation. Set `"status": "revoked"` to withdraw an approval.

## Honest limits
* Verified only with synthetic creators in a headless Chrome test; **not** with a real creator, a real file host
  or iPhone Safari.
* Trust rests on the maintainer's registry (a file in this repository) and on the creator keeping their key safe.
* Channel matching is by handle unless a channel ID is given (handles can change).
* No replay protection beyond `expiresAt`.
* Big files: an iPhone browser holds the file in memory. Files up to 200 MB download automatically, larger ones
  wait for a tap, files over 3 GB are refused.
* Other legitimate routes were considered but not built: creator-OAuth APIs (captions, analytics — they do not
  return video), YouTube's own Clips/Shorts remix features (not file sources). Cloud-storage integrations (Drive,
  Dropbox) need OAuth apps and are not free of setup; the signed-link model works with any host.
