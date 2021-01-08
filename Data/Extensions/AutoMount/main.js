module.exports.activate = () => {
    const flashpoint = require("flashpoint-launcher");
    const fs = require("fs");
    const util = require("util");
    const child_process = require("child_process");
    const path = require("path");

    const fsAccess = util.promisify(fs.access);

    const fpPath = flashpoint.config.flashpointPath;

    let alreadyLaunched = new Set();

    async function mountGame(id) {
        if(alreadyLaunched.has(id)) {
            return;
        }
        alreadyLaunched.add(id);

        try {
            await fsAccess(path.join(fpPath, "Games", `${id}.zip`));
        } catch(e) {
            flashpoint.log.info("No GameZIP detected.");
            return;
        }

        let fpmount = child_process.spawn(path.join(fpPath, "FPSoftware", "fpmount", "fpmount"), [id]);
        fpmount.stdout.on("data", data => flashpoint.log.info(`FPMount output: ${data}`));
        fpmount.stderr.on("data", data => flashpoint.log.info(`FPMount error: ${data}`));
        await new Promise((resolve, reject) => {
            fpmount.on("close", code => {
                if(code) {
                    flashpoint.log.info(`FPMount failed with error code: ${code}`);
                    reject();
                } else {
                    flashpoint.log.info(`FPMount succeeded.`);
                    resolve();
                }
            })
        });
    }

    flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
        await mountGame(gameLaunchInfo.game.id);
    });

    flashpoint.games.onWillLaunchAddApp(async (addAppInfo) => {
        if(addAppInfo.parentGame) {
            await mountGame(addAppInfo.parentGame.id);
        } else {
            flashpoint.log.error("Unable to determine parent game!");
        }
    });
};