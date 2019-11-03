// A fork of the [node.js chat app](https://github.com/eiriksm/chat-test-2k)
// by [@orkj](https://twitter.com/orkj) using socket.io, rethinkdb, passport and bcrypt on an express app.
//
// See the [GitHub README](https://github.com/rethinkdb/rethinkdb-example-nodejs-chat/blob/master/README.md)
// for details of the complete stack, installation, and running the app.
var express = require('express')
  , app = express()
  , cookieParser = require('cookie-parser')
  , bodyParser = require('body-parser')
  , expressSession = require('express-session')
  , server = require('http').createServer(app)
  , passport = require('passport')
  , flash = require('connect-flash')
  , local = require('passport-local').Strategy
  , bcrypt = require('bcryptjs')
  , io = require('socket.io').listen(server)
  , util = require('util')
  , db = require('./lib/db');

app.use(express.static('public'));
app.use(cookieParser());
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json());

app.use(expressSession({
    secret: 'keyboard cat',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash())

// set up the RethinkDB database
db.setup();





passport.use(new local(
  function(username, password, done) {
    // asynchronous verification, for effect...
    process.nextTick(function () {
      var validateUser = function (err, user) {
        if (err) { return done(err); }
        if (!user) { return done(null, false, {message: 'Usuário não encontrado: ' + username})}

        if (bcrypt.compareSync(password, user.password)) {
          return done(null, user);
        }
        else {
          return done(null, false, {message: 'Usuário ou senha inválidos.'});
        }
      };

      db.findUserByEmail(username, validateUser);
    });
  }
));

passport.serializeUser(function(user, done) {
  console.log("[DEBUG][passport][serializeUser] %j", user);
  done(null, user.id);
});

passport.deserializeUser(function (id, done) {
  db.findUserById(id, done);
});

/**
 * @todo Use routes. Just too lazy for now.
 */
app.post('/login',
  passport.authenticate('local', { failureRedirect: '/login', failureFlash: true }),
  function(req, res) {
    res.redirect('/chat');
  }
);

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});

app.get('/', function (req, res) {
  if (typeof req.user == 'undefined') {
    req.user = false;
  }
  res.render('index', { title: 'Equipe 1', user: req.user });
});

app.get('/login', function (req, res) {
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/chat');
  }
  else {
    req.user = false;
  }
  var message = req.flash('error');
  if (message.length < 1) {
    message = false;
  }
  res.render('login', { title: 'Login', message: message, user: req.user });
});

app.get('/account', ensureAuthenticated, function(req, res) {
  res.render('account', { user: req.user, title: 'Minha conta' });
});

app.get('/register', function(req, res){
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/account');
  }
  else {
    req.user = false;
  }
  var message = req.flash('error');
  if (message.length < 1) {
    message = false;
  }
  res.render('register', { title: 'Registrar', message: message, user: req.user });
});

app.post('/register', function(req, res){
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/account');
    return;
  }
  if (!validateEmail(req.param('email'))) {
    // Probably not a good email address.
    req.flash('error', 'Não é um e-mail válido.')
    res.redirect('/register');
    return;
  }
  if (req.param('password') !== req.param('password2')) {
    // 2 different passwords!
    req.flash('error', 'As senhas não correspondem!')
    res.redirect('/register');
    return;
  }

  // Saving the new user to DB
  db.saveUser({
      username: req.param('username'),
      mail: req.param('email'),
      password: bcrypt.hashSync(req.param('password'), 8)
    },
    function(err, saved) {
      console.log("[DEBUG][/register][saveUser] %s", saved);
      if(err) {
        req.flash('error', 'Ocorreu um erro ao criar a conta. Por favor, tente novamente.');
        res.redirect('/register');
        return
      }
      if(saved) {
        console.log("[DEBUG][/register][saveUser] /chat");
        res.redirect('/chat');
      }
      else {
        req.flash('error', 'A conta não foi criada.');
        res.redirect('/register');
        console.log("[DEBUG][/register][saveUser] /register");
      }
      return
    }
  );
});

app.get('/chat', ensureAuthenticated, function(req, res){
  res.render('chat', { user: req.user, title: 'Chat' });
});

app.get('/user/:uid', ensureAuthenticated, function(req, res){
  var user_id = req.params.uid;
  db.findUserById(user_id, function (err, user) {
    console.log("[DEBUG][/user/uid] %s -> {%j, %j}", user_id, err, user);
    if(err) {
      res.send(500);
      return
    }
    if(user === null) {
      res.send(404);
    }
    else {
      res.render('user', { seeUser: user, title: user.username, user: req.user });
    }
  });
});


var usersonline = {};

io.sockets.on('connection', function (socket) {
  var connected_user = {};

  // send updates with online users
  var i = setInterval(function() {
    socket.emit('whoshere', { 'users': usersonline });
  }, 3000);

  console.info("[DEBUG][io.sockets][connection]");


  socket.on('iamhere', function (data) {
    // This is sent by users when they connect, so we can map them to a user.
    console.log("[DEBUG][io.sockets][iamhere] %s", data);

    db.findUserById(data, function (err, user) {
      console.log("[DEBUG][iamhere] %s -> {%j, %j}", data, err, user);
      if (user !== null) {
        connected_user = user;
        usersonline[connected_user.id] = {
          id: connected_user.id,
          name: connected_user.username
        };
      }
    });
  });


  socket.on('message', function (data) {
    if (connected_user.username === undefined) {
      console.warn('[WARN][io.sockets][message] Got message before iamhere {%s}', util.inspect(data));
      socket.emit('new message', {message: '<em>Você deve fazer login antes de conversar. Essa é a regra</em>'});
      return
    }
    var msg = {
      message: data.message,
      from: connected_user.username,
      timestamp: new Date().getTime()
    }

    console.log("[DEBUG][io.sockets][message] New message '%j' from user %s(@%s)", msg, connected_user.username, connected_user.id);

    db.saveMessage(msg, function (err, saved) {
      if (err || !saved) {
        socket.emit('new message', {message: util.format("<em>Ocorreu um erro ao salvar sua mensagem (%s)</em>", msg.message), from: msg.from, timestamp: msg.timestamp});
        return;
      }
      socket.emit('new message', msg);

      // Send message to everyone.
      socket.broadcast.emit('new message', msg);
    });
  });

  db.findMessages(10, function (err, messages) {
    if (!err && messages.length > 0) {
      socket.emit('history', messages);
    }
  });


  socket.on('disconnect', function() {
    if (connected_user.id !== undefined) {
      delete usersonline[connected_user.id];
      console.log("[DEBUG][io.sockets][disconnect] user: %s(@%s) disconnected", connected_user.username, connected_user.id);
    }
    else {
      console.log("[WARN][io.sockets][disconnect] Received disconnect message from another univers");
    }
  });
});


function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login')
}

function validateEmail(email) {
  var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(email);
}

server.listen(8000);
