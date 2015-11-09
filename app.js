#!/usr/bin/env node

// Parses arguments
var argv = require('yargs')
	.usage('Usage: $0 --input=[backup dir] --output=[output dir]')
	.demand(['input', 'output'])
	.describe('input', 'The path of the iTunes backup')
	.describe('output', 'The output path. Must be a non-existant folder')
	.argv;
	
var fatality = function(message) {
	console.error("\n[ERR] " + message + "\n");
	process.exit(1);	
};
	
var path = require('path');
var backupDirectory = path.resolve(argv.input);
// HomeDomain-Library/SMS/sms.db -> in SHA1 3d0d7e5fb2ce288813306e4d4636395e047a3d28
var messagesDbPath = path.join(backupDirectory, "3d0d7e5fb2ce288813306e4d4636395e047a3d28");
var contactsDbPath = path.join(backupDirectory, "31bb7ba8914766d4ba40d6dfb6113c8b614be442");
var outputDirectory = path.resolve(argv.output);
	
// Check to make sure everything is good fs-wise
var fs = require('graceful-fs');

// Check that input directory exists
try {
	var stats = fs.statSync(backupDirectory);
	
	if (!stats.isDirectory()) {
		fatality("Input must be a directory.");
	}
} catch (e) {
	fatality("Input directory does not exist or cannot be read.");
}

// Check that messages db file is present
try {
	var stats = fs.statSync(messagesDbPath);
	
	if (!stats.isFile()) {
		throw new Error();
	}
} catch (e) {
	fatality("Input directory does not contain a readable messages file.");
}

// Check that contacts db file is present
try {
	var stats = fs.statSync(messagesDbPath);

	if (!stats.isFile()) {
		throw new Error();
	}
} catch (e) {
	fatality("Input directory does not contain a readable contacts file.");
}

// Check if output directory is empty or non-existant
try {
	var files = fs.readdirSync(outputDirectory);
	if (files.count !== 0) {
		fatality("Output directory is not empty.");
	}
} catch (e) {
	try {
		var stats = fs.statSync(outputDirectory);
		if (!stats.isDirectory()) {
			fatality("Output path is not a directory.");
		}
	} catch (e) {
		fs.mkdirSync(outputDirectory);
	}
}

// Establishes a MongoDB-like temporary datastore
var Datastore = require('nedb');
var contactsDb = new Datastore();
var conversationsDb = new Datastore();

// Connects to the SQLite DBs for messages and contacts
var sqlite3 = require('sqlite3').verbose();
var originalMessages = new sqlite3.Database(messagesDbPath, sqlite3.OPEN_READONLY);
var originalContacts = new sqlite3.Database(contactsDbPath, sqlite3.OPEN_READONLY);

// Load other needed modules
var crypto = require('crypto');
var async = require('async');
var hbs = require('handlebars');

// Establishes paths for output
var attachmentsPath = path.join(outputDirectory, '/attachments');
var conversationsPath = path.join(outputDirectory, '/conversations');
fs.mkdirSync(attachmentsPath);
fs.mkdirSync(conversationsPath);

// Copies a css file to the output directory
fs.createReadStream(__dirname+"/static/style.css").pipe(fs.createWriteStream(outputDirectory+'/style.css'));

/**
 * Creates a list of all handles (unique ID numbers) that the messages db assigns
**/

var createHandlesDb = function(callback) {
	
	var handles = [];
	
	// Queries the DB for all handles
	originalMessages.each("SELECT id, ROWID from handle", function(err, row) {
		handles.push({
			id: cleanNumber(row.id),
			handle: row.ROWID
		});
	}, function(err, rowCount) {
		callback(handles);
	});
};

/**
 * Creates a interim list of all of the contacts
 * Basically just dealing with Apple's weird AddressBookDB format
 * Allows you to lookup a contact by handle
**/

var createUserContactsLookupTable = function(callback) {
	var contacts = {};
	var people = [];
	
	// Essentially doing a JOIN manually here
	// I suppose I could reimplement this using a JOIN function, but this works well enough
	// Making contacts into a form that can be associated with the handles in messages db
	originalContacts.each("SELECT ROWID, First, Last FROM ABPerson", function(err, row) {
		people[row.ROWID] = {
			name: row.First + " " + row.Last,
			id: row.ROWID
		};
	}, function(err, rowCount) {
		originalContacts.each(
			"SELECT record_id, value FROM ABMultiValue WHERE property=3 OR property=4",
			function(err, row) {
				contacts[cleanNumber(row.value)] = people[row.record_id];
			},
			function(err, rowCount) {
				callback(contacts);
			}
		);
	});
};

/**
 * Creates the internal database for contacts
 * Maps messages db handles to contacts
**/

var createContactsDb = function(handles, contacts, callback) {
	// Finds the contact for each handle, then adds it to the db
	handles.forEach(function(element) {
		var name = contacts[element.id];
		if (name) {
			name = name.name;
		}
		var person = {
			name: name,
			id: element.id,
			handle: element.handle
		};
		contactsDb.insert(person);
	});
	callback();
};

/**
 * Compiles the list of conversations
**/

var buildConversations = function(callback) {
	
	// Find how many conversations exist
	originalMessages.get("SELECT COUNT(*) FROM chat", function(err, result) {
		
		var count = result["COUNT(*)"];
		
		// A count of conversations that have finished processing
		var completed = 0;
		
		// A callback to say that row was completed
		// Throws the main function callback after all rows finish
		
		// Waits 5 seconds before continuing just to be sure that
		// all file copies and db inserts have finished
		var completedRow = function() {
			completed += 1;
			if (completed >= count) {
				setTimeout(callback, 5000);
			}
		};
		
		// Executes on each conversation
		originalMessages.each("SELECT ROWID, style, room_name, display_name FROM chat", function(err, chat) {
			var conversation = {};
			
			// style == 43 is a Apple-defined element, meaning group message
			// standard messages are style == 45
			if (chat.style === 43) {
				conversation.group_message = true;
			} else {
				conversation.group_message = false;
			}
			
			conversation.dbid = chat.ROWID;
			
			// Selects all people in a conversation
			originalMessages.all("SELECT handle_id FROM chat_handle_join WHERE chat_id="+chat.ROWID, function(err, members) {
				conversation.members = [];
				
				// Adds all members' handles to the conversation object
				members.forEach(function(element) {
					conversation.members.push(element.handle_id);
				});
				
				// If a group message, sets title to display name
				// If one-to-one, sets it to the name of whom you are conversing
				if (conversation.group_message === true) {
					conversation.contact_id = chat.room_name;
					conversation.group_name = chat.display_name;
				} else {
					conversation.contact_id = conversation.members[0];
				}
				
				conversation.messages = [];
				
				// Adds the messages to the conversation object, fires the completedRow callback
				addMessages(conversation, function() {
					completedRow();
				});
			});
		});
		
	});
};

/**
 * Parses through all of the messages in a conversation and inserts them to the internal DB
**/

var addMessages = function(conversation, callback) {
	
	var messages = conversation.messages;
	
	// Selects all messages in the conversation
	originalMessages.all("SELECT message_id FROM chat_message_join WHERE chat_id="+conversation.dbid, function(err, ids) {
		
		// Apply this function to each message in the conversation
		async.each(
			ids,
			function(element, asyncCallback) {
				var messageId = element.message_id;
				
				// Pulls in the message information
				originalMessages.get(
					"SELECT ROWID, text, handle_id, service, date, is_from_me, cache_has_attachments, item_type, group_action_type, other_handle, group_title FROM message WHERE ROWID="+messageId,
					function(err, rawMessage) {
						var message = {};
						
						// Keep the ROWID to sort the imessages and SMS later on
						message.ROWID = rawMessage.ROWID;
						
						// Converts the date to something usable
						message.timestamp = machTimeToDate(rawMessage.date);
						
						// If there is a protocol, normalize it
						// Otherwise, it's SMS
						// For some reason, some of these are blank in the DB
						try {
							message.protocol = rawMessage.service.toLowerCase();
						} 
						catch (e) {
							message.protocol = "sms";
						}
						
						// If message is from yourself, set sender to undefined in the message object
						// Otherwise, make it the sender's own handle
						if (rawMessage.is_from_me === 1 || rawMessage.handle_id === 0) {
							message.sender = undefined;
						} else {
							message.sender = rawMessage.handle_id;
						}
						
						// Functions for various message types
						switch (rawMessage.item_type) {
							// A standard message
							case 0:
								message.isReadableMessage = true;
								
								// Removes weird attachment characters added to messages
								// Manages empty text exception
								if (!rawMessage.text) {
									console.log("Empty text");
									rawMessage.text = "ERROR";
									message.content = rawMessage.text;
								} else {
									message.content = rawMessage.text.replace(/\uFFFC/g, "");
								}
								break;
							
							// Add/remove group members
							case 1:
								if (rawMessage.group_action_type === 0) {
									message.type = "add";
								} else {
									message.type = "remove";
								}
								
								// Other handle is the one being added or removed
								message.other_handle = rawMessage.other_handle;
								break;
								
							// Change the group name
							case 2:
								message.type = "name";
								message.group_name = rawMessage.group_title;
								break;
								
							// Leave the group voluntarily
							case 3: 
								message.type = "leave";
								break;
						}
						
						// If there are attachments...
						if (rawMessage.cache_has_attachments === 1) {
							message.attachments = [];
							
							// Find all attachments for that message
							originalMessages.all(
								"SELECT filename, mime_type, transfer_name, attachment_id FROM attachment INNER JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id WHERE message_id="+messageId,
								function(err, attachments) {
									
									// A function to run on each attachment
									attachments.forEach(function(rawAttachment) {
										var attachment = {};
										
										// Converting the filename to the Apple backup filename format
										var filepath = rawAttachment.filename;
										
										// Somehow linked to old library / Specific case
										filepath = filepath.replace("/var/mobile","~");
										
										filepath = "MediaDomain-" + filepath.substr(2);
										
										// Store it before sha1 conversion
										var real_filepath = filepath;
										
										// Specific case where transfer_name is empty
										if (!rawAttachment.transfer_name) {
											rawAttachment.transfer_name = filepath.replace(/^.*[\\\/]/, '');
										}

										filepath = crypto.createHash('sha1').update(filepath).digest('hex');
										
										var filename = filepath + "-" + rawAttachment.transfer_name;
										
										attachment.filename = filename;
										// Transfer name = original file name
										attachment.transfer_name = rawAttachment.transfer_name;
										
										// If the file is an image, it will be embedded
										// If not, it will be linked in the resulting webpage
										if (rawAttachment.mime_type.substring(0,5) === "image") {
											attachment.isImage = true;
										} else {
											attachment.isImage = false;
										}
										
										// Copy the file if it exists
										var file_test = path.join(backupDirectory, filepath);
										if (fs.existsSync(file_test)) {
											fs.createReadStream(path.join(backupDirectory, filepath)).pipe(fs.createWriteStream(attachmentsPath+'/'+filename));
										} else {
											console.log( 'File Doesn\'t Exist:', real_filepath, file_test );
										}	
										
										message.attachments.push(attachment);
									});
									
									messages.push(message);
									asyncCallback();
								}
							);
						} else {
							messages.push(message);
							asyncCallback();
						}	
				});

			},
			function(err) {
				// Sorts messages by oldest to newest (based on ROWID)
				conversation.messages.sort(function(a, b) {
//					return a.timestamp - b.timestamp;
					return a.ROWID - b.ROWID;
				});
				// Inserts the conversation into the internal DB
				conversationsDb.insert(conversation, function() {
					callback();
				});
			} 	
		);
	});
};

/**
 * Creates the HTML pages for all of the conversations
**/

var createHTMLFiles = function(callback) {
	// Gets all conversations and contacts
	conversationsDb.find({}).sort({contact_id: 1}).exec(function(err, conversations) {
		contactsDb.find({}).exec(function(err, contacts) {
			
			// Creates an array of contacts by handle id # from the db
			var readableContacts = [];
			contacts.forEach(function(person) {
				readableContacts[person.handle] = person;
			});
			
			// Find the name for the contact
			// Either the person's name or phone number
			var getContactDisplayName = function(handle) {
				var contact = readableContacts[handle];
				if (contact.name) {
					return contact.name;
				} else {
					return contact.id;
				}
			};
			
			// Adds this as a function usable in handlebars templates
			hbs.registerHelper('displayName', function(sender, options) {
				return getContactDisplayName(sender);
			});
			
			// Creates the text for a group message metadata change
			hbs.registerHelper('statuschange', function() {
				var person;
				
				// If the sender is undefined, then it was "You"
				if (this.sender) {
					person = getContactDisplayName(this.sender);
				} else {
					person = "You";
				}
				
				// Text for each type
				switch (this.type) {
					case "add":
						return person+" added "+getContactDisplayName(this.other_handle)+" to the group.";
						break;
					case "remove":
						return person+" removed "+getContactDisplayName(this.other_handle)+" from the group.";
						break;
					case "name":
						return person+" changed the group name to <strong>"+this.group_name+"</strong>.";
						break;
					case "leave": 
						return person+" left the group.";
						break;
				}
				
			});
			
			// Creates rendering functions for Handlebars
			var renderConversation = hbs.compile(fs.readFileSync(__dirname+"/static/conversation.hbs", 'utf8'));
			var renderIndex = hbs.compile(fs.readFileSync(__dirname+"/static/index.hbs", 'utf8'));
			
			// Makes a list of conversations with human names
			conversations.forEach(function(conversation) {
				if (conversation.group_message) {
					if (conversation.group_name) {
						conversation.human_name = conversation.group_name;
					} else {
						// If a group message doesn't have a name, it is the first member and X others
						var firstMemberName = getContactDisplayName(conversation.members[0]);
						conversation.human_name = firstMemberName;
						for (var tempo = 1; tempo < conversation.members.length; tempo++) {
							var tempo_member = getContactDisplayName(conversation.members[tempo]);
							conversation.human_name = conversation.human_name + " and " + tempo_member;
						}
					}
				} else {
					conversation.human_name = getContactDisplayName(conversation.contact_id);
				}
			});
			
			// Concatenate SMS & imessages in the same thread
			var counter;
			var counter2;
			for (counter = 0; counter < conversations.length; ++counter) {
				var current_human_name = conversations[counter].human_name;
				var current_conversation_dbid = conversations[counter].dbid;
				var current_conversation = conversations[counter];
				for (counter2 = 0; counter2 < conversations.length; ++counter2) {
					if (conversations[counter2].human_name == current_human_name && current_conversation_dbid != conversations[counter2].dbid && conversations[counter2].human_name) {
						console.log ("Same person", conversations[counter2].human_name, " between ", current_conversation_dbid, " and ", conversations[counter2].dbid);
						// Concatenate tables
						var children = current_conversation.messages.concat(conversations[counter2].messages);
						current_conversation.messages = children;
						// Sorts messages by ROWID
						current_conversation.messages.sort(function(a, b) {
							return a.ROWID - b.ROWID;
						});
						conversations.splice(counter2--,1);
					}
				};
			};
			
			// Creates and writes the index file
			var indexHtml = renderIndex(conversations);
			fs.writeFile(outputDirectory+'/index.html', indexHtml);
			
			// Creates an HTML page for each conversation, and writes the file
			async.each(conversations, function(conversation, asyncCallback) {
				var html = renderConversation(conversation);
				fs.writeFile(conversationsPath+'/'+conversation.contact_id+".html", html, function() {
					asyncCallback();
				});
			});
			
		});
	});
};

/**
 * Creates JSON files for contacts and messages for the user's purposes
**/

var createJSONOutputFiles = function() {
	conversationsDb.find({}).sort({ timestamp: 1 }).exec(function(err, docs) {
		originalContacts.close();
		originalMessages.close();
		
		fs.writeFileSync(outputDirectory+'/messages.json', JSON.stringify(docs, null, "\t"));
		contactsDb.find({}).exec(function(err, contacts) {
			var output = [];
			contacts.forEach(function(person) {
				output[person.handle] = person;
			});
			fs.writeFileSync(outputDirectory+'/contacts.json', JSON.stringify(output, null, '\t'));
		});
	});
};

/**
 * This function normalizes phone numbers
**/

var cleanNumber = function(number) {
	
	// return any email addresses, which don't need to be processed
	
	if (number.indexOf("@") !== -1) {
		return number;
	}
	
	// Specific case -> The contact is not a number but text only
	if (number.match(/^\w/g)) {
		return number;
	}
	
	// Remove all non-digits
	number = number.replace(/\D/g, '');
	
	// Cut off preceding characters (like a +1)
	// Only works in USA (and Canada, probably) with numbers less than 10 digits
	// Longer numbers may cause some issues
	if (number.length > 10) {
		number = number.substring(number.length - 10);
	}
	
	return number;
	
};

/**
 * The Apple DB uses some weird date format, so this converts it to JS dates
**/

var machTimeToDate = function(mach) {
	return new Date((mach + 978307200) * 1000);
};

/**
 * Here's where all the action is
**/

console.log("\nWorking, please wait...");

createHandlesDb(function(handles) {
	createUserContactsLookupTable(function(contacts) {
		createContactsDb(handles, contacts, function() {
			buildConversations(function() {
				createJSONOutputFiles();
				createHTMLFiles();
				console.log('\nComplete! :)\n');
			});
		});
	});
});
