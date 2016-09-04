'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const Request = require('./request.js');
const debug = require('debug')('wechat');
const FormData = require('form-data');
const mime = require('mime');

const updateAPI = require('./utils').updateAPI;
const CONF = require('./utils').CONF;
const convertEmoji = require('./utils').convertEmoji;
const contentPrase = require('./utils').contentPrase;

// Private
const PROP = Symbol();
const API = Symbol();

class Wechat extends EventEmitter {

  constructor() {
    super();
    this[PROP] = {
      uuid: '',
      uin: '',
      sid: '',
      skey: '',
      passTicket: '',
      formateSyncKey: '',
      webwxDataTicket: '',
      deviceId: 'e' + Math.random().toString().substring(2, 17),

      baseRequest: {},
      syncKey: {}
    };

    this[API] = {
      jsLogin: 'https://login.wx.qq.com/jslogin',
      login: 'https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login'
    };

    this.uuidPromise = null;
    this.checkLoginPromise = null;
    this.checkLoginRejector = null;
    this.checkLoginResolver = null;

    this.syncErrorCount = 0;
    this.mediaSend = 0;
    this.state = CONF.STATE.init;

    this.user = []; // 登陆账号
    this.memberList = []; // 所有联系人

    this.contactList = []; // 个人联系人
    this.groupList = []; // 已保存群聊
    this.groupMemberList = []; // 所有群聊内联系人
    this.publicList = []; // 公众账号
    this.specialList = []; // 特殊账号

    this.request = new Request()
  }

  setProp(key, val) {
    this[PROP][key] = val
  }

  getProp(key) {
    return this[PROP][key]
  }

  // 通讯录好友
  get friendList() {
    let members = [];

    this.groupList.forEach(member => {
      members.push({
        username: member['UserName'],
        nickname: '群聊: ' + member['NickName'],
        py: member['RemarkPYQuanPin'] ? member['RemarkPYQuanPin'] : member['PYQuanPin'],
        avatar: this[API].baseUri.match(/http.*?\/\/.*?(?=\/)/)[0] + member.HeadImgUrl
      });
    });

    this.contactList.forEach(member => {
      members.push({
        username: member['UserName'],
        nickname: member['RemarkName'] ? member['RemarkName'] : member['NickName'],
        py: member['RemarkPYQuanPin'] ? member['RemarkPYQuanPin'] : member['PYQuanPin'],
        avatar: this[API].baseUri.match(/http.*?\/\/.*?(?=\/)/)[0] + member.HeadImgUrl
      });
    });

    return members;
  }

  getUUID() {
    let params = {
      'appid': 'wx782c26e4c19acffb',
      'fun': 'new',
      'lang': 'zh_CN'
    };

    this.state = CONF.STATE.uuid;

    this.uuidPromise = this.request({
      method: 'POST',
      url: this[API].jsLogin,
      params: params
    }).then(res => {
      let pm = res.data.match(/window.QRLogin.code = (\d+); window.QRLogin.uuid = "(\S+?)"/)
      if (!pm) {
        throw new Error('UUID错误: 格式错误')
      }
      let code = +pm[1];
      let uuid = this[PROP].uuid = pm[2];

      if (code !== 200) {
        throw new Error('UUID错误: ' + code)
      }

      if (this.checkLoginRejector) {
        this.checkLoginRejector('reload');
      }

      this.checkLoginPromise = new Promise((resolver, rejector) => {
        this.checkLoginResolver = resolver;
        this.checkLoginRejector = rejector;
      });

      this.emit('uuid', uuid);

      return uuid
    }).catch(err => {
      debug(err);
      throw new Error('获取UUID失败')
    });

    return this.uuidPromise;
  }

  loginHandler(payload) {
    debug(payload.code);

    switch (payload.code) {
      case 200:
        return payload;
        break;
      case 201:
        // scan
        this.checkLoginRequest();
        break;
      case 408:
        // wait
        this.checkLoginRequest();
        break;
      case 400:
      case 500:
      case 0:
      default:
        debug('reloading');
        this.checkLoginRejector('reload');
        this.getUUID();
        break;
    }

    return Promise.reject('ignore invalid code');
  }

  checkLoginRequest(tip) {
    let params = {
      'tip': tip !== 1 ? 0 : 1,
      'uuid': this[PROP].uuid,
      'r': ~new Date
    };

    return this.request({
      method: 'GET',
      url: this[API].login,
      params: params,
      timeout: 35e3,
      type: 'script'
    }).then(res => {
      let code = res.data.match(/window.code=(\d+);/);
      code = code ? +code[1] : 0;
      let redirect = res.data.match(/window.redirect_uri="(\S+?)";/);
      redirect = redirect ? redirect[1] : '';

      return {code, redirect};
    }).then(payload => this.loginHandler(payload)).then(payload => {
      this[API].rediUri = payload.redirect;
      this[API].baseUri = this[API].rediUri.substring(0, this[API].rediUri.lastIndexOf('/'));

      // 接口更新
      updateAPI(this[API]);

      this.checkLoginResolver();
      this.emit('login');
    }).catch(err => {
      debug(err);
      throw new Error('获取确认登录信息失败')
    });
  }

  checkLogin(tip) {
    this.checkLoginRequest(tip);

    return this.checkLoginPromise;
  }

  login() {
    return this.request({
      method: 'GET',
      url: this[API].rediUri + '&fun=new&version=v2'
    }).then(res => {
      this[PROP].skey = res.data.match(/<skey>(.*)<\/skey>/)[1];
      this[PROP].sid = res.data.match(/<wxsid>(.*)<\/wxsid>/)[1];
      this[PROP].uin = res.data.match(/<wxuin>(.*)<\/wxuin>/)[1];
      this[PROP].passTicket = res.data.match(/<pass_ticket>(.*)<\/pass_ticket>/)[1];
      if (res.headers['set-cookie']) {
        res.headers['set-cookie'].forEach(item => {
          if (item.indexOf('webwxDataTicket') !== -1) {
            this[PROP].webwxDataTicket = item.split('; ').shift().split('=').pop()
          }
        })
      }
      this[PROP].baseRequest = {
        'Uin': parseInt(this[PROP].uin, 10),
        'Sid': this[PROP].sid,
        'Skey': this[PROP].skey,
        'DeviceID': this[PROP].deviceId
      }
    }).catch(err => {
      debug(err);
      throw new Error('登录失败')
    })
  }

  init() {
    let params = {
      'r': +new Date()
    };

    let data = {
      BaseRequest: this[PROP].baseRequest
    };

    return this.request({
      method: 'POST',
      url: this[API].webwxinit,
      params: params,
      data: data,
      type: 'json'
    }).then(res => {
      let data = res.data;
      this.user = data['User'];

      this._updateSyncKey(data['SyncKey']);

      if (data['BaseResponse']['Ret'] !== 0) {
        throw new Error('微信初始化Ret错误' + data['BaseResponse']['Ret'])
      }
    }).catch(err => {
      debug(err);
      throw new Error('微信初始化失败')
    })
  }

  notifyMobile() {
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Code': 3,
      'FromUserName': this.user['UserName'],
      'ToUserName': this.user['UserName'],
      'ClientMsgId': +new Date()
    };
    return this.request({
      method: 'POST',
      url: this[API].webwxstatusnotify,
      data: data,
      type: 'json'
    }).then(res => {
      let data = res.data;
      if (data['BaseResponse']['Ret'] !== 0) {
        throw new Error('开启状态通知Ret错误' + data['BaseResponse']['Ret'])
      }
    }).catch(err => {
      debug(err);
      throw new Error('开启状态通知失败')
    })
  }

  getContact() {
    let params = {
      'lang': 'zh_CN',
      'seq': 0,
      'skey': this[PROP].skey,
      'r': +new Date()
    };
    return this.request({
      method: 'POST',
      url: this[API].webwxgetcontact,
      params: params,
      type: 'json'
    }).then(res => {
      let data = res.data;
      this.memberList = data['MemberList'];

      if (this.memberList.length === 0) {
        throw new Error('通讯录获取异常')
      }

      this.state = CONF.STATE.login;
      this.emit('login', this.memberList);

      for (let member of this.memberList) {
        member['NickName'] = convertEmoji(member['NickName']);
        member['RemarkName'] = convertEmoji(member['RemarkName']);

        if (member['VerifyFlag'] & 8) {
          this.publicList.push(member)
        } else if (CONF.SPECIALUSERS.indexOf(member['UserName']) > -1) {
          this.specialList.push(member)
        } else if (member['UserName'].indexOf('@@') > -1) {
          this.groupList.push(member)
        } else {
          this.contactList.push(member)
        }
      }
      debug('好友数量：' + this.memberList.length);
      return this.memberList
    }).catch(err => {
      debug(err);
      throw new Error('获取通讯录失败')
    })
  }

  batchGetContact() {
    let params = {
      'type': 'ex',
      'r': +new Date(),
      'lang': 'zh_CN'
    };
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Count': this.groupList.length,
      'List': this.groupList.map(member => {
        return {
          'UserName': member['UserName'],
          'EncryChatRoomId': ''
        }
      })
    };
    return this.request({
      method: 'POST',
      url: this[API].webwxbatchgetcontact,
      params: params,
      data: data,
      type: 'json'
    }).then(res => {
      let data = res.data;
      let contactList = data['ContactList'];

      for (let group of contactList) {
        for (let member of group['MemberList']) {
          this.groupMemberList.push(member)
        }
      }
      debug('群组好友总数：', this.groupMemberList.length);
      return this.groupMemberList
    }).catch(err => {
      debug(err);
      throw new Error('获取群组通讯录失败')
    })
  }

  syncPolling() {
    this._syncCheck().then(state => {
      if (state.retcode !== CONF.SYNCCHECK_RET_SUCCESS) {
        throw new Error('你登出了微信')
      } else {
        if (state.selector !== CONF.SYNCCHECK_SELECTOR_NORMAL) {
          return this._sync().then(data => {
            setTimeout(() => {
              this.syncPolling()
            }, 1000);
            this._handleMsg(data)
          })
        } else {
          debug('WebSync Normal');
          setTimeout(() => {
            this.syncPolling()
          }, 1000)
        }
      }
    }).catch(err => {
      if (++this.syncErrorCount > 3) {
        debug(err);
        this.emit('error', err);
        this.logout()
      } else {
        setTimeout(() => {
          this.syncPolling()
        }, 1000)
      }
    })
  }

  logout() {
    let params = {
      redirect: 1,
      type: 0,
      skey: this[PROP].skey
    };

    // data加上会出错，不加data也能登出
    // let data = {
    //   sid: this[PROP].sid,
    //   uin: this[PROP].uin
    // }
    return this.request({
      method: 'POST',
      url: this[API].webwxlogout,
      params: params
    }).then(res => {
      this.state = CONF.STATE.logout;
      this.emit('logout');
      return '登出成功'
    }).catch(err => {
      debug(err);
      this.state = CONF.STATE.logout;
      this.emit('logout');
      throw new Error('可能登出成功')
    })
  }

  start() {
    return Promise.resolve(this.state === CONF.STATE.uuid ? this.uuidPromise : this.getUUID())
        .then(() => this.checkLogin(1))
        .then(() => this.login())
        .then(() => this.init())
        .then(() => this.notifyMobile())
        .then(() => this.getContact())
        .then(() => this.batchGetContact())
        .then(() => {
          if (this.state !== CONF.STATE.login) {
            throw new Error('登陆失败，未进入SyncPolling')
          }
          return this.syncPolling()
        }).catch(err => {
          debug('启动失败', err);
          this.stop();
          throw new Error('启动失败')
        })
  }

  stop() {
    return this.state === CONF.STATE.login ? this.logout() : Promise.resolve()
  }

  sendMsg(msg, to) {
    let params = {
      lang: 'zh_CN'
    };
    let clientMsgId = +new Date() + '0' + Math.random().toString().substring(2, 5)
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'Msg': {
        'Type': 1,
        'Content': msg,
        'FromUserName': this.user['UserName'],
        'ToUserName': to,
        'LocalID': clientMsgId,
        'ClientMsgId': clientMsgId
      }
    };
    this.request({
      method: 'POST',
      url: this[API].webwxsendmsg,
      params: params,
      data: data,
      type: 'json'
    }).then(res => {
      let data = res.data;
      if (data['BaseResponse']['Ret'] !== 0) {
        throw new Error('发送信息Ret错误: ' + data['BaseResponse']['Ret'])
      }
    }).catch(err => {
      debug(err);
      throw new Error('发送信息失败')
    })
  }

  _syncCheck() {
    let params = {
      'r': +new Date(),
      'sid': this[PROP].sid,
      'uin': this[PROP].uin,
      'skey': this[PROP].skey,
      'deviceid': this[PROP].deviceId,
      'synckey': this[PROP].formateSyncKey
    };
    return this.request({
      method: 'GET',
      url: this[API].synccheck,
      params: params
    }).then(res => {
      let re = /window.synccheck={retcode:"(\d+)",selector:"(\d+)"}/;
      let pm = res.data.match(re);

      let retcode = +pm[1];
      let selector = +pm[2];

      return {
        retcode, selector
      }
    }).catch(err => {
      debug(err);
      throw new Error('同步失败')
    })
  }

  _sync() {
    let params = {
      'sid': this[PROP].sid,
      'skey': this[PROP].skey,
      'lang': 'zh_CN'
    };
    let data = {
      'BaseRequest': this[PROP].baseRequest,
      'SyncKey': this[PROP].syncKey,
      'rr': ~new Date()
    };
    return this.request({
      method: 'POST',
      url: this[API].webwxsync,
      params: params,
      data: data,
      type: 'json'
    }).then(res => {
      let data = res.data;
      if (data['BaseResponse']['Ret'] !== 0) {
        throw new Error('拉取消息Ret错误: ' + data['BaseResponse']['Ret'])
      }

      this._updateSyncKey(data['SyncKey']);
      return data
    }).catch(err => {
      debug(err);
      throw new Error('获取新信息失败')
    })
  }

  _handleMsg(data) {
    debug('Sync ', data['AddMsgList'].length, 'Message');

    data['AddMsgList'].forEach(msg => {
      let type = +msg['MsgType'];
      let fromUser = msg['FromUserName'] === this.user.UserName ? '我' : this._getUserRemarkName(msg['FromUserName']);
      let toUser = msg['ToUserName'] === this.user.UserName ? '我' : this._getUserRemarkName(msg['ToUserName']);
      let content = contentPrase(msg['Content']);

      msg.from = fromUser;
      msg.to = toUser;

      if (this.user.UserName === msg['FromUserName']) {
        msg.fromMe = true;
      }

      if (this.user.UserName === msg['ToUserName']) {
        msg.toMe = true;
      }

      switch (type) {
        case CONF.MSGTYPE_STATUSNOTIFY:
          debug(' Message: Init');
          this.emit('init-message');
          break;
        case CONF.MSGTYPE_TEXT:
          debug(' Text-Message: ', fromUser, ' -> ', toUser, ': ', content);
          this.emit('text-message', msg);
          break;
        case CONF.MSGTYPE_IMAGE:
          debug(' Image-Message: ', fromUser, ' -> ', toUser, ': ', content);
          this._getMsgImg(msg.MsgId).then(image => {
            msg.Content = image;
            this.emit('image-message', msg)
          });
          break;
        case CONF.MSGTYPE_VOICE:
          debug(' Voice-Message: ', fromUser, ' -> ', toUser, ': ', content);
          this._getVoice(msg.MsgId).then(voice => {
            msg.Content = voice;
            this.emit('voice-message', msg)
          });
          break;
        case CONF.MSGTYPE_EMOTICON:
          debug(' Emoticon-Message: ', fromUser, ' -> ', toUser, ': ', content);
          this._getEmoticon(content).then(emoticon => {
            msg.Content = emoticon;
            this.emit('emoticon-message', msg)
          });
          break;
        case CONF.MSGTYPE_VERIFYMSG:
          debug(' Message: Add Friend');
          this.emit('verify-message', msg);
          break
      }
    })
  }

  _getMsgImg(msgId) {
    let params = {
      MsgID: msgId,
      skey: this[PROP].skey
    };

    return this.request({
      method: 'GET',
      url: this[API].webwxgetmsgimg,
      params: params,
      type: 'arraybuffer'
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type']
      }
    }).catch(err => {
      debug(err);
      throw new Error('获取图片失败')
    })
  }

  _getVoice(msgId) {
    let params = {
      MsgID: msgId,
      skey: this[PROP].skey
    };

    return this.request({
      method: 'GET',
      url: this[API].webwxgetvoice,
      params: params,
      type: 'arraybuffer'
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type']
      }
    }).catch(err => {
      debug(err);
      throw new Error('获取声音失败')
    })
  }

  _getEmoticon(content) {
    return Promise.resolve().then(() => {
      return this.request({
        method: 'GET',
        url: content.match(/cdnurl = "(.*?)"/)[1],
        type: 'arraybuffer'
      })
    }).then(res => {
      return {
        data: res.data,
        type: res.headers['content-type'],
        url: res.request.url
      }
    }).catch(err => {
      debug(err);
      throw new Error('获取表情失败')
    })
  }

  _getHeadImg(member) {
    let url = this[API].baseUri.match(/http.*?\/\/.*?(?=\/)/)[0] + member.HeadImgUrl;
    return this.request({
      method: 'GET',
      url: url,
      type: 'arraybuffer'
    }).then(res => {
      let headImg = {
        data: res.data,
        type: res.headers['content-type']
      };
      member.HeadImg = headImg;
      return headImg
    }).catch(err => {
      debug(err);
      throw new Error('获取头像失败')
    })
  }

  _getUserRemarkName(uid) {
    for (let member of this.memberList) {
      if (member['UserName'] === uid) {
        return member['RemarkName'] ? member['RemarkName'] : member['NickName']
      }
    }
    debug('不存在用户', uid);
    return uid
  }

  _updateSyncKey(syncKey) {
    this[PROP].syncKey = syncKey;
    let synckeylist = [];
    for (let e = this[PROP].syncKey['List'], o = 0, n = e.length; n > o; o++) {
      synckeylist.push(e[o]['Key'] + '_' + e[o]['Val'])
    }
    this[PROP].formateSyncKey = synckeylist.join('|')
  }
}

Wechat.STATE = CONF.STATE;

exports = module.exports = Wechat;
