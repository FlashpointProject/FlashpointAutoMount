module.exports.activate = () => {
    const flashpoint = require("flashpoint-launcher");
    const fs = require("fs");
    const util = require("util");

    const fsAccess = util.promisify(fs.access);
    const fsWriteFile = util.promisify(fs.writeFile);

    flashpoint.games.onWillLaunchGame(async (gameLaunchInfo) => {
        let id = gameLaunchInfo.game.id;


        try {
            await fsAccess(`..\\Games\\${id}.zip`);
            await fsWriteFile("..\\Legacy\\htdocs\\localmount.txt", `mount /localmount/${id}.zip`, "utf8");
        } catch(e) {
            flashpoint.log.info("No GameZIP detected.");
            await fsWriteFile("..\\Legacy\\htdocs\\localmount.txt", ``, "utf8");
        }
    });
};