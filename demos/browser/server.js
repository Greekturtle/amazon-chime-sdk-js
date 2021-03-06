// Copyright 2019-2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const AWS = require('aws-sdk');
const compression = require('compression');
const fs = require('fs');
const http = require('http');
const url = require('url');
const uuid = require('uuid/v4');

const {createLogger, format, transports} = require('winston');
require('winston-daily-rotate-file');
const {combine, timestamp, label, printf} = format;

const loggerFormat = printf(({level, message, label, timestamp}) => {
    return `${message}`;
});


var transport = new transports.DailyRotateFile({
    filename: 'logs/oculus-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
});

var meetingDataLogTransport = new transports.DailyRotateFile({
    filename: 'logs/oculus-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d'
});

transport.on('rotate', function (oldFilename, newFilename) {
    // do something fun
});

const metricsLogger = createLogger({
    format: combine(
        label({label: 'performance'}),
        timestamp(),
        loggerFormat
    ),
    transports: [transport]
});

const meetingDataLogger = createLogger({
    format: combine(
        label({label: 'performance'}),
        timestamp(),
        loggerFormat
    ),
    transports: [transport]
});

// Store created meetings in a map so attendees can join by meeting title
const meetingTable = {};

// Use local host for application server
const host = '127.0.0.1:8895';

// Load the contents of the web application to be used as the index page
const indexPage = fs.readFileSync(`dist/${process.env.npm_config_app || 'meetingV2'}.html`);

// Create ans AWS SDK Chime object. Region 'us-east-1' is currently required.
// Use the MediaRegion property below in CreateMeeting to select the region
// the meeting is hosted in.
const chime = new AWS.Chime({region: 'us-east-1'});


// Set the AWS SDK Chime endpoint. The global endpoint is https://service.chime.aws.amazon.com.
chime.endpoint = new AWS.Endpoint(process.env.ENDPOINT || 'https://service.chime.aws.amazon.com');

// Start an HTTP server to serve the index page and handle meeting actions
http.createServer({}, async (request, response) => {
    log(`${request.method} ${request.url} BEGIN`);
    const startTime = (new Date()).getTime();
    let responseStatus = 200;
    const requestUrl = url.parse(request.url, true);
    try {
        // Enable HTTP compression
        compression({})(request, response, () => {
        });

        if (request.method === 'GET' && requestUrl.pathname === '/') {
            // Return the contents of the index page
            respond(response, 200, 'text/html', indexPage);
        } else if (process.env.DEBUG && request.method === 'POST' && requestUrl.pathname === '/join') {
            // For internal debugging - ignore this.
            responseStatus = 201;
            respond(response, 201, 'application/json', JSON.stringify(require('./debug.js').debug(requestUrl.query), null, 2));
        } else if (request.method === 'POST' && requestUrl.pathname === '/join') {
            if (!requestUrl.query.title || !requestUrl.query.name || !requestUrl.query.region) {
                throw new Error('Need parameters: title, name, region');
            }

            // Look up the meeting by its title. If it does not exist, create the meeting.
            if (!meetingTable[requestUrl.query.title]) {
                meetingTable[requestUrl.query.title] = await chime.createMeeting({
                    // Use a UUID for the client request token to ensure that any request retries
                    // do not create multiple meetings.
                    ClientRequestToken: uuid(),
                    // Specify the media region (where the meeting is hosted).
                    // In this case, we use the region selected by the user.
                    MediaRegion: requestUrl.query.region,
                    // Any meeting ID you wish to associate with the meeting.
                    // For simplicity here, we use the meeting title.
                    ExternalMeetingId: requestUrl.query.title.substring(0, 64),
                }).promise();
            }

            // Fetch the meeting info
            const meeting = meetingTable[requestUrl.query.title];

            // Create new attendee for the meeting
            const attendee = await chime.createAttendee({
                // The meeting ID of the created meeting to add the attendee to
                MeetingId: meeting.Meeting.MeetingId,

                // Any user ID you wish to associate with the attendeee.
                // For simplicity here, we use a random id for uniqueness
                // combined with the name the user provided, which can later
                // be used to help build the roster.
                ExternalUserId: `${uuid().substring(0, 8)}#${requestUrl.query.name}`.substring(0, 64),
            }).promise();
            // Return the meeting and attendee responses. The client will use these
            // to join the meeting.
            responseStatus = 201;
            respond(response, 201, 'application/json', JSON.stringify({
                JoinInfo: {
                    Meeting: meeting,
                    Attendee: attendee,
                },
            }, null, 2));
        } else if (request.method === 'POST' && requestUrl.pathname === '/end') {
            // End the meeting. All attendee connections will hang up.
            await chime.deleteMeeting({
                MeetingId: meetingTable[requestUrl.query.title].Meeting.MeetingId,
            }).promise();
            respond(response, 200, 'application/json', JSON.stringify({}));
        } else {
            responseStatus = 404;
            respond(response, 404, 'text/html', '404 Not Found');
        }
    } catch (err) {
        responseStatus = 400;
        respond(response, 400, 'application/json', JSON.stringify({error: err.message}, null, 2));
    }
    log(`${request.method} ${request.url} END`);

    const endTime = (new Date()).getTime();

    let msg = (endTime-startTime)+',';
    msg+=request.method+',';
    msg+=responseStatus+',';
    msg+='oculus-user'+',';
    msg+='Oculus-NA'+',';
    msg+='oculus'+requestUrl.pathname+',';
    msg+= 'oculus'+requestUrl.pathname+',';
    msg+= 'oculus'+requestUrl.pathname+'/'+requestUrl.query.title+',';
    msg+= 'oculus,';
    msg+= '0.0.0.0,';
    msg+= 'NA,';
    msg+= 'NA,';
    msg+= 'NA';
    metricsLogger.info(msg);


}).listen(host.split(':')[1], host.split(':')[0], () => {
    log(`server running at http://${host}/`);
});

function log(message) {
    console.log(`${new Date().toISOString()} ${message}`);
};

function respond(response, statusCode, contentType, body) {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', contentType);
    response.end(body);
    if (contentType === 'application/json') {
        log(body);
    }
}
