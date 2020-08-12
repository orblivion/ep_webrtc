// vim: et:ts=2:sw=2:sts=2:ft=javascript
/**
 * Copyright 2013 j <j@mailb.org>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var log4js = require('ep_etherpad-lite/node_modules/log4js')
var statsLogger = log4js.getLogger("stats");
var configLogger = log4js.getLogger("configuration");
var commentJson = require('comment-json'); // TODO - vet this dependency. see if it has good tests.
var eejs = require('ep_etherpad-lite/node/eejs/');
var settings = require('ep_etherpad-lite/node/utils/Settings');
var sessioninfos = require('ep_etherpad-lite/node/handler/PadMessageHandler').sessioninfos;
var stats = require('ep_etherpad-lite/node/stats')
var socketio;
var hooks = require("ep_etherpad-lite/static/js/pluginfw/hooks");
var fs = require('fs');

/**
 * Handles an RTC Message
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleRTCMessage(client, payload)
{
  var userId = sessioninfos[client.id].author;
  var to = payload.to;
  var padId = sessioninfos[client.id].padId;
  var room = socketio.sockets.adapter.rooms[padId];
  var clients = [];

  if (room && room.sockets) {
    for (var id in room.sockets) {
      clients.push(socketio.sockets.sockets[id]);
    }
  }

  var msg = {
    type: "COLLABROOM",
    data: {
      type: "RTC_MESSAGE",
      payload: {
        from: userId,
        data: payload.data
      }
    }
  };
  // Lookup recipient and send message
  for(var i = 0; i < clients.length; i++) {
    var session = sessioninfos[clients[i].id];
    if(session && session.author == to) {
      clients[i].json.send(msg);
      break;
    }
  }
}

// Make sure any updates to this are reflected in README
const statErrorNames = [
  "Abort",
  "Hardware",
  "NotFound",
  "NotSupported",
  "Permission",
  "SecureConnection",
  "Unknown"
]

function handleErrorStatMessage(statName) {
  if (statErrorNames.indexOf(statName) !== -1) {
    stats.meter("ep_webrtc_err_" + statName).mark();
  } else {
    statsLogger.warn("Invalid ep_webrtc error stat: " + statName);
  }
}

exports.clientVars = function(hook, context, callback)
{
  // Validate settings.json now so that the admin notices any errors right away
  if (!validateSettings()) {
    return callback({
      webrtc: {
        "configError": true
      }
    })
  }

  var audioDisabled = "none";
  if(settings.ep_webrtc && settings.ep_webrtc.audio) {
    audioDisabled = settings.ep_webrtc.audio.disabled;
  }

  var videoDisabled = "none";
  if(settings.ep_webrtc && settings.ep_webrtc.video) {
    videoDisabled = settings.ep_webrtc.video.disabled;
  }

  var iceServers = [ {"url": "stun:stun.l.google.com:19302"} ];
  if(settings.ep_webrtc && settings.ep_webrtc.iceServers) {
    iceServers = settings.ep_webrtc.iceServers;
  }

  var listenClass = false;
  if(settings.ep_webrtc && settings.ep_webrtc.listenClass) {
    listenClass = settings.ep_webrtc.listenClass;
  }

  var videoSizes = {};
  if(settings.ep_webrtc && settings.ep_webrtc.video && settings.ep_webrtc.video.sizes) {
    videoSizes = {
      large: settings.ep_webrtc.video.sizes.large,
      small: settings.ep_webrtc.video.sizes.small
    }
  }

  return callback({
    webrtc: {
      "iceServers": iceServers,
      "disabled": rtcDisabledInSettings(),
      "audio": {"disabled": audioDisabled},
      "video": {"disabled": videoDisabled, "sizes": videoSizes},
      "listenClass": listenClass
    }
  });
};

exports.handleMessage = function ( hook, context, callback )
{
  if (context.message.type == 'COLLABROOM' && context.message.data.type == 'RTC_MESSAGE') {
    handleRTCMessage(context.client, context.message.data.payload);
    callback([null]);
  } else if (context.message.type == 'STATS' && context.message.data.type == 'RTC_MESSAGE') {
    handleErrorStatMessage(context.message.data.statName);
    callback([null]);
  } else {
    callback();
  }
};

exports.setSocketIO = function (hook, context, callback)
{
  // TODO - is this namespace for admin a good idea and correctly used vis a vis the client code?
  socketio = context.io.of("/webrtc-admin");

  function createNewSettings(oldSettings, fields) {
    const settingsObj = commentJson.parse(oldSettings)

    const settingsObjModified = commentJson.assign(settingsObj, {
      "ep_webrtc": commentJson.assign(settingsObj["ep_webrtc"], {
        "enabled": undefined, // Removing deprecated field
        "disabled": fields["disabled"],
        "audio": commentJson.assign(settingsObj["ep_webrtc"]["audio"], {
          "disabled": fields["audio_disabled"],
        }),
        "video": {
          "disabled": fields["video_disabled"],
        },
      })
    })

    return commentJson.stringify(settingsObjModified, null, 2)
  }

  socketio.on('connection', function (socket) {

    if (!socket.conn.request.session || !socket.conn.request.session.user || !socket.conn.request.session.user.is_admin) return;

    // TODO - do I need this permission to stop using this tab in general?
    // if(settings.showSettingsInAdminPage === false) {
    //   socket.emit("settingsDiff", {results:'NOT_ALLOWED'});
    // }
    // else {
    //   socket.emit("settingsDiff", {results: diff});
    // }

    socket.on("saveSettings", function (args) {
      // TODO socket stuff like the other settings.json panel. and all the other
      // stuff currently in that endpoint in etherpad-lite
      // TODO Change the warning to make sure they're not editing somewhere else at the
      //      same time.
      // TODO - check authorization here as well

      fs.readFile('settings.json', 'utf8', function (err, oldSettings) {
        if (err) {
          return console.log(err);
        }
        // TODO - async
        // TODO - several backups; bk1, bk2, etc
        fs.writeFileSync('settings.json.bk', oldSettings)

        const newSettings = createNewSettings(oldSettings, args.fields)

        // TODO - async again
        fs.writeFileSync('settings.json', newSettings)
        socket.emit("saveprogress", "saved");

        // TODO - maybe restart always on save? Otherwise if you revisit this admin
        // page, the old settings are still in the checkboxes!
      })
    });

    socket.on("restartServer", function () {
      console.log("Admin request to restart server through a socket on /admin/webrtc");
      settings.reloadSettings();
      hooks.aCallAll("restartServer", {}, function () {});
    });

  });

  callback();
};

exports.eejsBlock_adminMenu = function (hook, context, cb)
{
    context.content += eejs.require('ep_webrtc/templates/admin/adminMenuEntry.ejs', {});
    cb();
};

exports.registerRoute = function (hook_name, args, cb) {
  args.app.get("/admin/webrtc", function(req, res) {
    if (!validateSettings()) {
      res.send(eejs.require("ep_webrtc/templates/admin/settings.html", {
        errors: ["Validation error in settings.json. See server logs."] // TODO have it spit out the errors here
      }))
      return
    }

    var disabled = rtcDisabledInSettings() ? 'checked' : 'unchecked';

    var audioDisabled = "none";
    if(settings.ep_webrtc && settings.ep_webrtc.audio){
      audioDisabled = settings.ep_webrtc.audio.disabled;
    }

    var videoDisabled = "none";
    if(settings.ep_webrtc && settings.ep_webrtc.video){
      videoDisabled = settings.ep_webrtc.video.disabled;
    }

    res.send(eejs.require("ep_webrtc/templates/admin/settings.html", {
      errors : [], // TODO - need this? copied from etherpad-lite settings
      disabled : disabled,
      audio_disabled: audioDisabled,
      video_disabled: videoDisabled
    }))
  })

  cb()
};

exports.eejsBlock_mySettings = function (hook, context, callback)
{
    var audioDisabled = "none";
    if(settings.ep_webrtc && settings.ep_webrtc.audio) {
      audioDisabled = settings.ep_webrtc.audio.disabled;
    }

    var videoDisabled = "none";
    if(settings.ep_webrtc && settings.ep_webrtc.video) {
      videoDisabled = settings.ep_webrtc.video.disabled;
    }

    context.content += eejs.require('ep_webrtc/templates/settings.ejs', {
      "audio_hard_disabled": audioDisabled === "hard",
      "video_hard_disabled": videoDisabled === "hard"
    });
    callback();
};

exports.eejsBlock_editorContainerBox = function (hook_name, args, cb) {
  args.content = args.content + eejs.require("ep_webrtc/templates/webrtc.ejs", {}, module);
  return cb();
};

exports.eejsBlock_styles = function (hook_name, args, cb) {
  args.content = args.content + eejs.require("ep_webrtc/templates/styles.html", {}, module);
  return cb();
};

function validateSettings() {
  if(settings.ep_webrtc) {
    if(settings.ep_webrtc.enabled !== undefined && settings.ep_webrtc.disabled !== undefined) {
      configLogger.error("Can't use both ep_webrtc.enabled (deprecated) and ep_webrtc.disabled in settings.json")
      return false
    }

    if(settings.ep_webrtc.disabled !== undefined) {
      if (
        settings.ep_webrtc.disabled !== true &&
        settings.ep_webrtc.disabled !== false
      ) {
        configLogger.error("Invalid value in settings.json for ep_webrtc.disabled")
        return false
      }
    }

    if(settings.ep_webrtc.audio && settings.ep_webrtc.audio.disabled !== undefined) {
      if (
        settings.ep_webrtc.audio.disabled !== "none" &&
        settings.ep_webrtc.audio.disabled !== "hard" &&
        settings.ep_webrtc.audio.disabled !== "soft"
      ) {
        configLogger.error("Invalid value in settings.json for ep_webrtc.audio.disabled")
        return false
      }
    }

    if(settings.ep_webrtc.video && settings.ep_webrtc.video.disabled !== undefined) {
      if (
        settings.ep_webrtc.video.disabled !== "none" &&
        settings.ep_webrtc.video.disabled !== "hard" &&
        settings.ep_webrtc.video.disabled !== "soft"
      ) {
        configLogger.error("Invalid value in settings.json for ep_webrtc.video.disabled")
        return false
      }
    }
  }
  return true
}

function rtcDisabledInSettings() {
  if(settings.ep_webrtc) {
    if(settings.ep_webrtc.disabled !== undefined) {
      return settings.ep_webrtc.disabled
    }
    if(settings.ep_webrtc.enabled !== undefined) {
      configLogger.warn("ep_webrtc.enabled in settings.json is deprecated. Use ep_webrtc.disabled instead.")
      return settings.ep_webrtc.enabled === false
    }
  }
  return false
}
