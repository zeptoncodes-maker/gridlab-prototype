# How to Run GridLab

These steps use **Git Bash**, not the regular Windows Command Prompt
(cmd). If you don't have Git Bash yet, it comes bundled with
[Git for Windows](https://git-scm.com/downloads).

---

## Step 1: Install Node.js

GridLab needs Node.js to run.

1. Open Git Bash.
2. Type `node -v` and press Enter.
3. If you see a version number, you're good — skip to Step 2.
4. If you see an error, download and install Node.js from
   [nodejs.org](https://nodejs.org) (pick the LTS version), then repeat
   step 2 to confirm it worked.

---

## Step 2: Install pnpm

GridLab uses a tool called **pnpm** to install its pieces (instead of
the more common `npm`).

In Git Bash, run:

```
npm install -g pnpm
```

Then confirm it installed:

```
pnpm -v
```

You should see a version number.

---

## Step 3: Get the project files

If you don't have the project yet, download it from GitHub:

```
git clone https://github.com/zeptoncodes-maker/gridlab-prototype.git
```

Then move into that folder:

```
cd gridlab-prototype
```

(If you already have the folder — from a USB drive, a zip file, etc. —
just open Git Bash and `cd` into that folder instead of cloning.)

---

## Step 4: Install the project's pieces

Still inside the `gridlab-prototype` folder, run:

```
pnpm install
```

This downloads everything the app needs to run. It can take a few
minutes, especially on a slower internet connection — that's normal.

**If this step fails** with an error mentioning `@electron/get`, see the
Troubleshooting section at the bottom of this file.

---

## Step 5: Run the app

Run:

```
pnpm dev
```

A GridLab window should open after a few seconds.

**Important:** always use `pnpm dev` while testing or making changes —
not `pnpm start`. `pnpm start` only opens an old, already-built version
of the app and won't reflect anything new. `pnpm dev` is the one that
runs the app live.

---

## Stopping the app

Click back into the Git Bash window and press `Ctrl + C` to stop it.

---

## Troubleshooting

### "Cannot find module '@electron/get'" during `pnpm install`

This is a known hiccup between pnpm and Electron, not a problem with
GridLab itself. Fix it like this:

1. Make sure there's a file named `.npmrc` in the project folder
   (same folder as `package.json`) containing this line:
   ```
   shamefully-hoist=true
   ```
   If it's not there, create it.
2. Delete the `node_modules` folder:
   ```
   rm -rf node_modules
   ```
3. Run `pnpm install` again.

### The app opens but looks old / my changes aren't showing up

Make sure you're running `pnpm dev`, not `pnpm start`. If you already
had `pnpm dev` running, fully stop it (`Ctrl + C`) and start it again
rather than leaving an old one running in the background.

### Still stuck?

Copy the exact error text from Git Bash and ask for help with that exact
message — it makes it much faster to figure out what's wrong.
