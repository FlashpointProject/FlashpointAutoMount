module.exports.activate = () => {
    const flashpoint = require("flashpoint-launcher");
    const child_process = require("child_process");
    const path = require("path");

    const fpPath = flashpoint.config.flashpointPath;
    const dataPacksPath = path.join(fpPath, flashpoint.config.dataPacksFolderPath);

    let alreadyLaunched = new Set();

    async function mountGame(id, filePath) {
        if(alreadyLaunched.has(id)) {
            return;
        }
        alreadyLaunched.add(id);

        let fpmount = child_process.spawn(path.join(fpPath, "FPSoftware", "fpmount", "fpmount"), [id, filePath]);
        fpmount.stdout.on("data", data => flashpoint.log.info(`FPMount output: ${data}`));
        fpmount.stderr.on("data", data => flashpoint.log.info(`FPMount error: ${data}`));
        return new Promise((resolve, reject) => {
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
        if (gameLaunchInfo.activeData) {
            if (gameLaunchInfo.activeData.presentOnDisk) {
                // Data present, mount it now
                flashpoint.log.debug("GameData present on disk, mounting...");
                const filePath = path.join(dataPacksPath, gameLaunchInfo.activeData.path)
                return mountGame(gameLaunchInfo.game.id, filePath);
            } else {
                throw "GameData found but not downloaded, cannot mount.";
            }
        } else {
            flashpoint.log.debug("AutoMount skipping, no GameData registered for Game. Assuming Legacy game.");
        }
    });

    flashpoint.games.onWillLaunchAddApp(async (addAppInfo) => {
        if(addAppInfo.parentGame) {
            if (addAppInfo.parentGame.activeDataId) {
                const activeData = await flashpoint.gameData.findOne(addAppInfo.parentGame.activeDataId)
                if (activeData && activeData.presentOnDisk) {
                    // Data present, mount it now
                    flashpoint.log.debug("GameData present on disk, mounting...");
                    const filePath = path.join(dataPacksPath, activeData.path)
                    return mountGame(addAppInfo.parentGame.id, filePath);
                } else {
                    throw "GameData found but not downloaded, cannot mount.";
                }
            } else {
                flashpoint.log.debug("AutoMount skipping, no GameData registered for AddApps's Game. Assuming Legacy game.");
            }
        } else {
            flashpoint.log.error("Unable to determine parent game!");
        }
    });
};