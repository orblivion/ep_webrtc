// Taken mostly from settings in etherpad-lite admin
$(document).ready(function () {
  var socket,
    // TODO - sort this stuff out
    loc = document.location,
    port = loc.port == "" ? (loc.protocol == "https:" ? 443 : 80) : loc.port,
    url = loc.protocol + "//" + loc.hostname + ":" + port + "/",
    pathComponents = location.pathname.split('/'),
    // Strip admin/plugins
    baseURL = pathComponents.slice(0,pathComponents.length-2).join('/') + '/',
    resource = baseURL.substring(1) + "socket.io";

  //connect
  // TODO -hmm.... all this
  var room = url + "webrtc-admin";
  socket = io.connect(room, {path: baseURL + "socket.io", resource : resource});

  /* Check whether the settings.json is authorized to be viewed */
  /* TODO - delete this or use it as appropriate */
  /*
  if(settings.results === 'NOT_ALLOWED') {
    $('.innerwrapper').hide();
    $('.innerwrapper-err').show();
    $('.err-message').html("Settings json is not authorized to be viewed in Admin page!!");
    return;
  }
  */

  function getUpdatedData() {
    // TODO Only use stuff selected by $('.settingToUpdate') so we make sure
    // it's not missed in the diff when they change it.
    return {
      'disabled': $("#options-disabled").prop('checked'),
      'audio_disabled': $("#options-audiodisabled").prop('value'),
      'video_disabled': $("#options-videodisabled").prop('value')
    }
  }

  $('#saveSettings').on('click', function(){
    socket.emit("saveSettings", {fields: getUpdatedData()});
  });

  /* Tell Etherpad Server to restart */
  $('#restartEtherpad').on('click', function(){
    socket.emit("restartServer");
  });

  socket.on('saveprogress', function(progress){
    $('#response').show();
    $('#response').text(progress);
    $('#response').fadeOut('slow');
  });
});
