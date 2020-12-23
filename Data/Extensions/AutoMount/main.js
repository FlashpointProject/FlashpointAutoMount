module.exports.activate = () => {
    const flashpoint = require("flashpoint-launcher");
    const fs = require("fs");
    const util = require("util");
    const child_process = require("child_process");

    const fsAccess = util.promisify(fs.access);

    let alreadyLaunched = new Set();

    flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
        let id = gameLaunchInfo.game.id;

        if(alreadyLaunched.has(id)) {
            return;
        }
        alreadyLaunched.add(id);

        try {
            await fsAccess(`..\\Games\\${id}.zip`);
        } catch(e) {
            flashpoint.log.info("No GameZIP detected.");
            return;
        }

        let fpmount = child_process.spawn("..\\FPSoftware\\fpmount\\fpmount", [id]);
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
    });
};