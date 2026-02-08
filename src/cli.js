#!/usr/bin/env node
/**
 * Lark CLI - Command line interface for Lark/Feishu API
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { testAuth } from './lib/client.js';
import { sendToGroup, sendToUser, listMessages, uploadImage, sendImage, uploadFile, sendFile, downloadImage, downloadFile } from './lib/message.js';
import { getDocument, getDocumentInfo, getWikiNode, getSpreadsheet, getSheetValues, writeSheetValues, copySheet, addSheet } from './lib/document.js';
import { listEvents } from './lib/calendar.js';
import { listChats, searchChats, listChatMembers } from './lib/chat.js';
import { getUserId, getUserInfo } from './lib/contact.js';

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`
Lark CLI - Interact with Lark/Feishu workspace

Usage: lark-cli <command> [options]

Commands:
  test                           Test API authentication

  send-group <chat_id> <msg>     Send message to a group
  send-user <user_id> <msg>      Send message to a user
  send-image <chat_id> <path>    Send image to a chat
  send-file <chat_id> <path>     Send file to a chat
  download-image <msg_id> <key> <path>  Download image from message
  download-file <msg_id> <key> <path>   Download file from message
  messages <chat_id> [options]   List messages in a chat
                                 --limit N    Max messages (default: 50)
                                 --today      Only today's messages
                                 --days N     Messages from last N days

  doc <doc_id>                   Get document content
  doc <doc_id> --info            Get document metadata
  wiki <token>                   Get wiki node info
  sheet <token>                  Get spreadsheet info
  sheet-read <token> <range>     Read spreadsheet data
  sheet-write <token> <range> <v1> <v2>... Write values to a row
  sheet-copy <token> <sheetId> <newTitle>  Copy a sheet
  sheet-add <token> <title>      Add a new empty sheet

  calendar [--days N]            List calendar events (default: 7 days)

  chats                          List all chats
  members <chat_id>              List members of a chat
  search-chat <query>            Search chats by keyword

  user <email_or_mobile>         Get user ID by email or mobile
  user-info <id>                 Get user info by user_id or open_id (ou_xxx)

Examples:
  lark-cli test
  lark-cli send-group oc_xxx "Hello team!"
  lark-cli messages oc_xxx --limit 10
  lark-cli doc doccnXXX
  lark-cli sheet-read TOKEN SheetId!A1:D20
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  try {
    let result;

    switch (command) {
      case 'test':
        result = await testAuth();
        break;

      case 'send-group':
        if (args.length < 3) {
          console.error('Usage: lark-cli send-group <chat_id> <message>');
          process.exit(1);
        }
        result = await sendToGroup(args[1], args[2]);
        break;

      case 'send-user':
        if (args.length < 3) {
          console.error('Usage: lark-cli send-user <user_id> <message>');
          process.exit(1);
        }
        result = await sendToUser(args[1], args[2]);
        break;

      case 'send-image':
        if (args.length < 3) {
          console.error('Usage: lark-cli send-image <chat_id> <image_path>');
          process.exit(1);
        }
        const uploadImgResult = await uploadImage(args[2]);
        if (!uploadImgResult.success) {
          console.error(`Failed to upload image: ${uploadImgResult.message}`);
          process.exit(1);
        }
        result = await sendImage(args[1], uploadImgResult.imageKey);
        break;

      case 'send-file':
        if (args.length < 3) {
          console.error('Usage: lark-cli send-file <chat_id> <file_path>');
          process.exit(1);
        }
        const uploadFileResult = await uploadFile(args[2]);
        if (!uploadFileResult.success) {
          console.error(`Failed to upload file: ${uploadFileResult.message}`);
          process.exit(1);
        }
        result = await sendFile(args[1], uploadFileResult.fileKey);
        break;

      case 'download-image':
        if (args.length < 4) {
          console.error('Usage: lark-cli download-image <message_id> <image_key> <save_path>');
          process.exit(1);
        }
        result = await downloadImage(args[1], args[2], args[3]);
        break;

      case 'download-file':
        if (args.length < 4) {
          console.error('Usage: lark-cli download-file <message_id> <file_key> <save_path>');
          process.exit(1);
        }
        result = await downloadFile(args[1], args[2], args[3]);
        break;

      case 'messages':
        if (args.length < 2) {
          console.error('Usage: lark-cli messages <chat_id> [--limit N] [--today] [--days N]');
          process.exit(1);
        }
        const msgLimit = args.includes('--limit')
          ? parseInt(args[args.indexOf('--limit') + 1]) || 50
          : 50;

        let startTime = null;
        let endTime = Math.floor(Date.now() / 1000);

        if (args.includes('--today')) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          startTime = Math.floor(today.getTime() / 1000);
        } else if (args.includes('--days')) {
          const daysAgo = parseInt(args[args.indexOf('--days') + 1]) || 1;
          const past = new Date();
          past.setDate(past.getDate() - daysAgo);
          past.setHours(0, 0, 0, 0);
          startTime = Math.floor(past.getTime() / 1000);
        }

        result = await listMessages(args[1], msgLimit, 'desc', startTime, endTime);
        if (result.success && result.messages) {
          console.log(`Found ${result.messages.length} messages:\n`);
          result.messages.forEach(msg => {
            const time = new Date(msg.createTime).toLocaleString();
            console.log(`[${time}] ${msg.sender}: ${msg.content}`);
          });
          process.exit(0);
        }
        break;

      case 'doc':
        if (args.length < 2) {
          console.error('Usage: lark-cli doc <doc_id> [--info]');
          process.exit(1);
        }
        if (args.includes('--info')) {
          result = await getDocumentInfo(args[1]);
        } else {
          result = await getDocument(args[1]);
          if (result.success) {
            console.log(result.content);
            process.exit(0);
          }
        }
        break;

      case 'wiki':
        if (args.length < 2) {
          console.error('Usage: lark-cli wiki <token>');
          process.exit(1);
        }
        result = await getWikiNode(args[1]);
        if (result.success && result.node) {
          console.log(`Title: ${result.node.title}`);
          console.log(`Type: ${result.node.objType}`);
          console.log(`Object Token: ${result.node.objToken}`);
          process.exit(0);
        }
        break;

      case 'sheet':
        if (args.length < 2) {
          console.error('Usage: lark-cli sheet <token>');
          process.exit(1);
        }
        result = await getSpreadsheet(args[1]);
        if (result.success && result.spreadsheet) {
          console.log(`Title: ${result.spreadsheet.title}`);
          console.log(`URL: ${result.spreadsheet.url}`);
          if (result.spreadsheet.sheets) {
            console.log(`\nSheets:`);
            result.spreadsheet.sheets.forEach(s => {
              console.log(`  [${s.index}] ${s.sheetId}: ${s.title}`);
            });
          }
          process.exit(0);
        }
        break;

      case 'sheet-read':
        if (args.length < 3) {
          console.error('Usage: lark-cli sheet-read <token> <range>');
          process.exit(1);
        }
        result = await getSheetValues(args[1], args[2]);
        if (result.success && result.values) {
          console.log(`Range: ${result.range}\n\nData:`);
          result.values.forEach((row, i) => {
            console.log(`  Row ${i + 1}: ${row.join(' | ')}`);
          });
          process.exit(0);
        }
        break;

      case 'sheet-write':
        if (args.length < 4) {
          console.error('Usage: lark-cli sheet-write <token> <range> <value1> [value2] ...');
          process.exit(1);
        }
        const writeValues = args.slice(3);
        result = await writeSheetValues(args[1], args[2], [writeValues]);
        if (result.success) {
          console.log(`Written to ${args[2]}: ${writeValues.join(' | ')}`);
          process.exit(0);
        }
        break;

      case 'sheet-copy':
        if (args.length < 4) {
          console.error('Usage: lark-cli sheet-copy <token> <sourceSheetId> <newTitle>');
          process.exit(1);
        }
        result = await copySheet(args[1], args[2], args[3]);
        break;

      case 'sheet-add':
        if (args.length < 3) {
          console.error('Usage: lark-cli sheet-add <token> <title>');
          process.exit(1);
        }
        result = await addSheet(args[1], args[2]);
        break;

      case 'calendar':
        const days = args.includes('--days')
          ? parseInt(args[args.indexOf('--days') + 1]) || 7
          : 7;
        result = await listEvents(days);
        if (result.success && result.events) {
          if (result.events.length === 0) {
            console.log('No events found.');
            process.exit(0);
          }
          result.events.forEach(event => {
            const start = new Date(event.startTime).toLocaleString();
            const end = new Date(event.endTime).toLocaleString();
            console.log(`[${start} - ${end}] ${event.summary}`);
          });
          process.exit(0);
        }
        break;

      case 'chats':
        result = await listChats();
        if (result.success && result.chats) {
          result.chats.forEach(chat => {
            console.log(`${chat.id}  ${chat.name} (${chat.memberCount} members)`);
          });
          process.exit(0);
        }
        break;

      case 'members':
        if (args.length < 2) {
          console.error('Usage: lark-cli members <chat_id>');
          process.exit(1);
        }
        result = await listChatMembers(args[1]);
        if (result.success && result.members) {
          result.members.forEach(member => {
            console.log(`${member.memberId}  ${member.name || '(no name)'}`);
          });
          process.exit(0);
        }
        break;

      case 'search-chat':
        if (args.length < 2) {
          console.error('Usage: lark-cli search-chat <query>');
          process.exit(1);
        }
        result = await searchChats(args[1]);
        if (result.success && result.chats) {
          result.chats.forEach(chat => {
            console.log(`${chat.id}  ${chat.name} (${chat.memberCount} members)`);
          });
          process.exit(0);
        }
        break;

      case 'user':
        if (args.length < 2) {
          console.error('Usage: lark-cli user <email_or_mobile>');
          process.exit(1);
        }
        result = await getUserId(args[1]);
        if (result.success && result.user) {
          console.log(`user_id: ${result.user.userId}`);
          process.exit(0);
        }
        break;

      case 'user-info':
        if (args.length < 2) {
          console.error('Usage: lark-cli user-info <user_id_or_open_id>');
          process.exit(1);
        }
        result = await getUserInfo(args[1]);
        if (result.success && result.user) {
          console.log(`user_id: ${result.user.userId}`);
          console.log(`open_id: ${result.user.openId}`);
          console.log(`name: ${result.user.name}`);
          process.exit(0);
        }
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }

    if (result) {
      if (result.success) {
        console.log(result.message || JSON.stringify(result, null, 2));
      } else {
        console.error(`Error: ${result.message}`);
        process.exit(1);
      }
    }

  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
