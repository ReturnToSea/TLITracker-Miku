//tor/main.js

const fs = require('fs');
const fsPromises = require('fs').promises;
const readline = require('readline');
const isDev = process.env.NODE_ENV === 'development';

// 非开发环境屏蔽 console.log，但保留 console.error 和 console.warn
if (!isDev) {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
}

let nowLogPath =
  'E:\\game\\SteamLibrary\\steamapps\\common\\Torchlight Infinite CN\\UE_game\\TorchLight\\Saved\\Logs\\UE_game.log';

nowLogPath = 'C:\\Users\\71042\\Downloads\\UE_game.log';

// yyyy MM dd HH mm ss :SSS  需要+8小时变成中国时间
const msgStartReg =
  /\[([^\]]+)\]\[[^\]]+\]GameLog:\sDisplay:\s\[Game\]\s-+.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sSTT-+([^-]+)-+SynId\s=\s(\d*).*/i;

const logList = [];
const msgList = [];
let lastSearchPriceId = null;
let lastNotCompleteMsg = null;

// 初始化时读取最后100行
const excludePattern = /SoundTriggerTimestamps|GameplayLog|error:|Warning|PushMgr@RecvLogicMsg/i;

let isRunning = false;
let lastPosition = 0;
let currentWatcher = null; // 保存当前监听器引用
let callback = null; // 保存 callback 引用，用于 notifyCanReadMore

// -- 流控相关 --
let isReading = false;
let canReadMore = true;
const MAX_READ_SIZE = 512 * 1024;
let pendingResumeScheduled = false;

// -- 新增：用于处理高频事件的健壮机制 --
let hasNewChanges = false; // 标志位：fs.watch 是否通知了有新变化
let processingInterval = null; // 定时器：唯一的、规律的“执行者”
const PROCESSING_INTERVAL_MS = 250; // 每 250ms 检查一次新日志，这是一个平衡了响应速度和性能的合理值

/**
 * 启动日志监听 (重构版)
 */
async function mainWatch(logPath, routeLogMessage) {
  if (isRunning && logPath === nowLogPath) {
    console.log('日志监听已在相同路径运行，跳过重复启动');
    return;
  }

  // 先彻底停止所有旧的监听和定时器
  stopTorLog();

  nowLogPath = logPath;
  isRunning = true;
  callback = routeLogMessage; // 保存回调函数
  console.log('开始监听tor日志:', nowLogPath);

  try {
    const stats = await fsPromises.stat(nowLogPath);
    // 每次启动都从文件末尾开始，这是最符合用户预期的行为
    lastPosition = stats.size;
    console.log('Starting from end of file:', lastPosition);

    // =================================================================
    // 核心修改：fs.watch 只负责“通知”，不直接触发处理
    // =================================================================
    currentWatcher = fs.watch(nowLogPath, { persistent: true }, (eventType, filename) => {
      if (eventType === 'change') {
        // 收到变化信号，只设置标志位，不做任何其他事
        hasNewChanges = true;
      } else if (eventType === 'rename') {
        // rename 事件比较特殊，需要立即处理
        // 传递最新的 callback
        handleRename(nowLogPath, callback).catch((err) => {
          console.error('处理 rename 事件时发生未捕获的错误:', err);
          stopTorLog();
        });
      }
    });

    currentWatcher.on('error', (error) => {
      console.error('文件监听发生错误:', error);
      stopTorLog();
    });

    // =================================================================
    // 核心修改：启动唯一的、规律的“执行者”定时器
    // =================================================================
    processingInterval = setInterval(() => {
      // 如果没有新变化待处理，或者正在读取中，或者流控暂停，则本次轮询跳过
      if (!hasNewChanges || isReading || !canReadMore) {
        // console.log('没有新变化，跳过处理',hasNewChanges,isReading,canReadMore)
        return;
      }

      // 检测到标志位为 true，开始处理
      console.log('[定时执行器] 检测到新变化，准备处理...');

      // 重置标志位。即使处理失败，下次也要等新的 change 事件再触发
      hasNewChanges = false;

      // 调用日志处理函数
      processNewLogs(callback).catch((error) => {
        console.error('[定时执行器] 处理日志时发生未捕获的错误:', error);
        // 发生错误时，确保 isReading 状态被重置，以便下次能继续
        isReading = false;
      });
    }, PROCESSING_INTERVAL_MS);
  } catch (error) {
    console.error('启动日志监听失败:', error);
    isRunning = false;
    // 确保清理
    stopTorLog();
  }
}

/**
 * 停止日志监听 (重构版)
 */
function stopTorLog() {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  // 关键：确保“执行者”定时器也被清除
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
  }

  // 重置所有状态变量
  isRunning = false;
  isReading = false;
  canReadMore = true;
  hasNewChanges = false;
  nowLogPath = '';
  callback = null;

  console.log('已停止监听tor日志');
}
function getStatus() {
  return {
    isRunning,
    logPath: nowLogPath,
    lastPosition,
  };
}

/**
 * 处理新日志 (逻辑基本不变，但调用时机被定时器控制)
 */
async function processNewLogs(cb) {
  // 入口处的并发和流控检查现在由 setInterval 的回调函数负责
  // 但我们保留 isReading 标志的设置，以防万一
  if (isReading) return;

  isReading = true;
  pendingResumeScheduled = false;

  try {
    const currentSize = (await fsPromises.stat(nowLogPath)).size;

    if (currentSize > lastPosition) {
      const bytesToRead = currentSize - lastPosition;
      const maxReadBytes = Math.min(bytesToRead, MAX_READ_SIZE);
      const readEndPosition = lastPosition + maxReadBytes;

      console.log(`读取新日志: ${bytesToRead} 字节，本次读取: ${maxReadBytes} 字节`);

      if (bytesToRead > MAX_READ_SIZE) {
        canReadMore = false;
        console.log(`日志量过大，暂停读取。剩余 ${bytesToRead - maxReadBytes} 字节待读取`);
      }
      let linesProcessed = 0;
      const stream = fs.createReadStream(nowLogPath, {
        start: lastPosition,
        end: readEndPosition - 1,
        encoding: 'utf8',
      });

      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        if (!excludePattern.test(line)) {
          if (cb) {
            try {
              cb(line);
              linesProcessed++;
            } catch (error) {
              console.error('调用 callback 时出错:', error);
            }
          } else {
            console.log('callback 为空', line);
          }
        } else {
          // console.log('excludePattern 匹配到 跳过',line)
        }
      });

      // stream.on('end', () => {
      //   isReading = false;
      //   // 如果还有活儿，并且阀门是开的，就自己干，不求人！
      //   if (readEndPosition < currentSize && canReadMore) {
      //     processNewLogs(cb).catch(console.error);
      //   }
      // });

      stream.on('end', () => {
        lastPosition = readEndPosition;
        if (readEndPosition >= currentSize) {
          canReadMore = true;
          console.log('已读取到文件末尾，恢复读取');
        } else {
          console.log(`等待 Worker 处理完成，剩余 ${currentSize - readEndPosition} 字节`);
        }
        if (linesProcessed === 0) {
          console.log('没有处理到任何行，跳过处理');
          canReadMore = true;
        }
        isReading = false;

        // 如果流控允许且还有数据，则重新设置 hasNewChanges 标志，
        // 让下一个定时器周期立即处理剩余部分。
        if (readEndPosition < currentSize && canReadMore) {
          hasNewChanges = true;
        }
      });

      stream.on('error', (error) => {
        console.error('读取日志流时出错:', error);
        canReadMore = true;
        isReading = false;
      });
    } else {
      // 文件大小没有增加，可能是误报
      isReading = false;
    }
  } catch (error) {
    console.error('处理新日志时出错:', error);
    canReadMore = true;
    isReading = false;
  }
}

// 更新回调函数（用于页面刷新后更新回调引用）
function updateCallback(newCallback) {
  if (isRunning && newCallback) {
    console.log('更新日志回调函数');
    callback = newCallback;
    // 同时重置流控标志，确保可以继续读取
    canReadMore = true;
  }
}

// 新增函数：处理日志文件重命名/轮替事件
async function handleRename(currentLogPath, currentCallback) {
  console.log(`检测到日志文件可能已轮替: ${currentLogPath}`);

  // 1. 立即停止当前的监听，因为它可能已经失效
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  isRunning = false; // 暂时标记为停止

  // 2. 使用延迟和重试机制来等待新文件创建
  // 日志系统重命名旧文件和创建新文件之间可能有微小的延迟
  const maxRetries = 5;
  const retryDelay = 200; // 200ms

  for (let i = 0; i < maxRetries; i++) {
    try {
      // 尝试访问新文件，确认它是否已存在
      await fsPromises.access(currentLogPath, fs.constants.F_OK);

      // 如果文件存在，说明轮替已完成
      console.log('新日志文件已确认存在，准备重新启动监听...');

      // 关键：重置 lastPosition 为 0，因为我们要从新文件的开头开始读
      lastPosition = 0;

      // 重新调用 mainWatch 来启动对新文件的监听
      // 使用 setTimeout(..., 0) 是为了将重启操作放到下一个事件循环中，
      // 避免与当前的文件系统事件处理发生冲突。
      setTimeout(() => mainWatch(currentLogPath, currentCallback), 0);

      return; // 成功处理，退出函数
    } catch (error) {
      // 如果文件不存在，等待一小段时间再重试
      console.log(`等待新文件创建... (尝试 ${i + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  // 如果重试多次后新文件仍不存在，则记录错误并彻底停止
  console.error(`日志文件轮替后，新文件 ${currentLogPath} 未在预期时间内出现。监听已停止。`);
  stopTorLog();
}

// 重置流控标志（用于恢复读取）
function resetFlowControl() {
  if (isRunning) {
    console.log('重置流控标志');
    canReadMore = true;
    hasNewChanges = true; // 设置标志，以便下一个定时器周期可以立即尝试读取
  }
}

// 通知可以继续读取（由 WSS 回调调用）
function notifyCanReadMore() {
  const wasReadable = canReadMore;
  canReadMore = true;
  if (!wasReadable) {
    console.log('收到 Worker 处理完成信号，恢复日志读取');
  }

  // 若不在读取中，则设置标志，让下一个定时器周期可以开始处理
  if (!isReading && isRunning) {
    hasNewChanges = true;
  }
}

function notifyCanReadMore111() {
  if (!canReadMore) {
    canReadMore = true;
    // 不再依赖任何标志位，直接尝试启动下一次处理！
    processNewLogs(callback).catch(console.error);
  }
}

function dealMsg(s) {
  logList.push(s);

  const isMsgEnd = s.match(/.*(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\sEnd.*/i);
  if (isMsgEnd) {
    if (s.match(/SyncArea/)) {
      console.log('SyncArea:', s, msgStart);
    }
    if (!lastNotCompleteMsg) {
      console.log('未匹配到消息开始，但检测到消息结束:', logList);
      logList.length = 0;
    } else {
      // console.log(lastNotCompleteMsg.action)
      logList.length = 0;

      if (
        lastNotCompleteMsg.action.match(
          /BroadcastChat|SyncArea|Spv3Info|SpGuideInfo|SpCardInfo|SpTalentTreeInfo|SavePlayerClientData|S11GetGamePlayData|ReturnClientStoredData|MainCityFrameDataApi|SetClientStoredData|UpdateSpeedUpPointLag|Ping|GetRollNotice|ActiveFlag|HeartBeat|GetServerTime|GlobalSpeedUpPointList/i,
        )
      ) {
        //绕过
        /**
         * BroadcastChat 聊天信息
         * PushMsg 一些任务 技能信息推送
         * SyncArea 同步区域内人信息
         * SpTalentTreeInfo 卡牌天赋树
         * SpCardInfo 卡牌信息
         * SpGuideInfo 卡牌指引信息？
         * Spv3Info 卡牌v3信息
         */
      } else if (lastNotCompleteMsg.action == 'PortalLeftNum') {
        // 剩余的传送门
      } else if (lastNotCompleteMsg.action == 'PickItem') {
        //捡东西
        const items = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('捡东西:', items);
      } else if (lastNotCompleteMsg.action == 'PickItems') {
        //捡一堆东西
        const items = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('捡一堆东西:', items);
      } else if (lastNotCompleteMsg.action == 'XchgSyncSoldSale') {
        //市集售出？
      } else if (lastNotCompleteMsg.action == 'InputArea') {
        //地图内检测
        const areaInfo = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        /**
         * cmds：[
         *  CmdData ：{
         *    type: ECmd_DestoryRole 摧毁上一个图？  ECmd_CreateRole 创建新图  ECmd_TalentBlock_Equip 天赋安装？   ECmd_EquipHeroCharacter 特性？
         * }
         *
         * ]
         */
        if (areaInfo.frameId && areaInfo.frameId < 3) {
          console.log('InputArea:', areaInfo);
        }
      } else if (
        lastNotCompleteMsg.action == 'Spv3Open' &&
        lastNotCompleteMsg.type == 'SendMessage'
      ) {
        //开图
        /**
		 *   '+ArrSpecItemBaseIDs',
	'+MapID [1001002]',
	'+levelId [0]',
	'+areaId [1000]',
	'+ArrItemBaseIDs',
	'+MultiArea [false]'
		 */
      } else if (
        lastNotCompleteMsg.action == 'Spv3Open' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //开图成功
        /**
         */
      } else if (
        lastNotCompleteMsg.action == 'Spv3Enter' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //进图
      } else if (
        lastNotCompleteMsg.action == 'EnterArea' &&
        lastNotCompleteMsg.type == 'SendMessage'
      ) {
        //进入区域   '+heroId [1600]', '+name [放课后袭击魔灵]'
      } else if (
        lastNotCompleteMsg.action == 'EnterArea' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //进入区域
        /**
		 * '+p4version [4222817]',
	'+AreaUniqueId [3314649325744692261]',
	'+worldInitArgs+ownerPlayerId [814971382814871552]',
	'|             +seed [1532413606]',
	'|             +battleTag [62]',
	'|             +levelId [110]',
	'|             +replaceAffixClass+1 []',
	'|             +extraArgs+1+KeyType [CheckRepeatInput]',
	'|             |         | +value [1]',
	'|             |         +2+KeyType [CheckGamePlayUnitState]',
	'|             |         | +value [1]',
	'+areaId [110_df24d82e-ae4f-11f0-b2ba-00000000005c]',
	'+mapId [111000]',
	'+checkType [MainCity]'
		 */
      } else if (
        lastNotCompleteMsg.action == 'SpCardInfo' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //地图卡牌信息
      } else if (lastNotCompleteMsg.action == 'ResetItemsLayout') {
        //重置背包
        /**
         * 100 装备
         * 101 技能
         * PageId: '102' 通货背包
         * 103 其他
         */
        const items = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('背包:', items);
      } else if (lastNotCompleteMsg.action == 'GetWareHousePage') {
        //仓库
        const items = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('仓库:', items);
        fs.writeFileSync('warehouse.json', JSON.stringify(items, null, 2));
        fs.writeFileSync('warehouse.txt', lastNotCompleteMsg.data.join('\n'));
      } else if (
        lastNotCompleteMsg.action == 'XchgSyncSearchPrice' &&
        lastNotCompleteMsg.type == 'SendMessage'
      ) {
        //查价发起
        const data = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('查价发起XchgSyncSearchPrice', data);
        if (data['itemBaseId'] > 0) {
          lastSearchPriceId = data['itemBaseId'];
        }
      } else if (
        lastNotCompleteMsg.action == 'XchgSearchPrice' &&
        lastNotCompleteMsg.type == 'SendMessage'
      ) {
        //查价发起
        const data = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('查价发起XchgSearchPrice', data);
        lastSearchPriceId = data['filters']['1']['refer'];
      } else if (
        lastNotCompleteMsg.action == 'XchgSearchPrice' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //查价结果
        parseSearchPriceData(lastNotCompleteMsg.data.join('\n'), lastSearchPriceId);
      } else if (
        lastNotCompleteMsg.action == 'GetBDContent' &&
        lastNotCompleteMsg.type == 'RecvMessage'
      ) {
        //GetBDContent结果
        const items = parseTorchlightData(lastNotCompleteMsg.data.join('\n'));
        console.log('BD结果:', JSON.stringify(items, null, 2));
      } else {
        console.log('完整消息:', lastNotCompleteMsg);
      }
      msgList.push(lastNotCompleteMsg);
    }
    lastNotCompleteMsg = null;
  } else {
    const msgStart = s.match(msgStartReg);

    if (msgStart) {
      const time = timeToTimestamp(msgStart[1]);
      // if (Math.abs(time - new Date().getTime()) > 10 * 1000) {
      //   console.log('时间差:', time - new Date().getTime(), time, new Date().getTime());
      //   console.log('时间差超过10秒，不处理:', msgStart);
      // } else {
      lastNotCompleteMsg = {
        //'2025.10.18-10.18.14:493'
        start: timeToTimestamp(msgStart[1]),
        type: msgStart[2],
        action: msgStart[3],
        synId: msgStart[4],
        data: [],
      };
      // }
    } else if (lastNotCompleteMsg && !s.match(/errCode/) && !s.match(/^\[[^\]]+\].*GameLog.*/)) {
      lastNotCompleteMsg.data.push(s);
    }
  }

  // [2025.10.18-08.57.57:488][486]GameLog: Display: [Game] ----Socket SendMessage STT----ActiveFlag----SynId = 11941

  //查价开始
  // [2025.10.18-08.57.57:933][543]GameLog: Display: [Game] ----Socket SendMessage STT----XchgSearchPrice----SynId = 11942

  //[2025.10.18-08.57.57:933][543]GameLog: Display: [Game] ----Socket SendMessage STT----XchgSyncSearchPrice----SynId = 11943
  // +itemBaseId [3004]

  /**
   * 
   * [2025.10.18-08.57.57:967][548]GameLog: Display: [Game] ----Socket RecvMessage STT----XchgSearchPrice----SynId = 11942
	  [2025.10.18-08.57.57:967][548]GameLog: Display: [Game]
	  +prices+1+currency [100300]
	  +errCode
	  +itemGoldId [3004]
   * 
   */
}

//时间转化
function timeToTimestamp(time) {
  const [date, timeStr] = time.split('-');
  const [year, month, day] = date.split('.');
  const [timeNoMs, ms] = timeStr.split(':');
  const [hour, minute, second] = timeNoMs.split('.');
  return (
    new Date(`${year}-${month}-${day} ${hour}:${minute}:${second}.${ms}`).getTime() +
    8 * 60 * 60 * 1000
  );
}

/**
 * 解析火炬之光无限的自定义树状文本数据 (V2 - 修正版)。
 * @param {string} textData - 原始的文本数据。
 * @returns {object} - 解析后的JavaScript对象。
 */
function parseTorchlightData(textData) {
  const root = {};

  const lines = textData
    .trim()
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('+errCode'))
    .map((line) => line.trim());

  const lastKeys = [];
  for (const line of lines) {
    let copyLine = line;
    let keys = line
      .split('+')
      .map((line) => line.trim())
      .filter((key) => key);
    lastKeys.forEach((key) => {
      copyLine = copyLine.replace('|', '+' + key);
    });
    keys = copyLine
      .split('+')
      .map((line) => line.trim())
      .filter((key) => key);
    lastKeys.length = 0;
    lastKeys.push(...keys.filter((a) => !a.match(/(\S+).*\[([^\]]*)\]/)));
    let currentContext = root;
    for (let i = 0; i < keys.length; i++) {
      const valueMatch = keys[i].match(/(\S+).*\[([^\]]*)\]/);
      if (valueMatch) {
        currentContext[valueMatch[1]] = valueMatch[2];
      } else if (!currentContext[keys[i]]) {
        currentContext[keys[i]] = {};
      }
      currentContext = currentContext[keys[i]];
    }
  }

  return root;
}

/**
 * 查价解析
 */
function parseSearchPriceData(textData, lastSearchPriceId) {
  const data = parseTorchlightData(textData);
  data['lastSearchPriceId'] = lastSearchPriceId;
  let unitPrices = [];
  Object.keys(data.prices).forEach((key) => {
    const price = data.prices[key];
    if (price.currency == 100300) {
      //火
      Object.keys(price.unitPrices).forEach((i) => {
        unitPrices.push(price.unitPrices[i]);
      });
    }
  });

  //合并相同价格
  const mergedPrices = unitPrices.reduce((acc, price) => {
    const a = price.match(/(0\.0*).*/);
    let fixNum = 1;
    if (a) {
      fixNum = a[1].length;
    }
    const key = `${Number(Number(price).toFixed(fixNum))}`;
    if (!acc[key]) {
      acc[key] = 1;
    } else {
      acc[key] += 1;
    }
    return acc;
  }, {});

  //排序
  const sortedPrices = Object.keys(mergedPrices).sort((a, b) => mergedPrices[b] - mergedPrices[a]);

  const itemPrice = {
    name: itemMap[lastSearchPriceId],
    id: lastSearchPriceId,
    price: sortedPrices.length > 0 ? sortedPrices[0] : 0,
  };
  console.log(itemPrice);
}

const itemMap = {};

function initItemMap() {
  try {
    const text = fs.readFileSync('itemId.txt', 'utf-8');
    const lines = text.split('\n');
    lines.forEach((line) => {
      const [id, name] = line.replace(/\r/, '').split(' ');
      if (id && name) {
        itemMap[id] = name;
      }
    });
  } catch (error) {
    console.error('读取itemId.txt失败:', error.message);
  }
}

// const text = fs.readFileSync('warehouse.txt', 'utf-8');
// parseTorchlightData(text)

// initItemMap();
// mainWatch()

module.exports = {
  initItemMap,
  mainWatch,
  stopTorLog,
  getStatus,
  parseTorchlightData,
  parseSearchPriceData,
  timeToTimestamp,
  notifyCanReadMore,
  updateCallback,
  resetFlowControl,
};
