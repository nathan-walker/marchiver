#marchiver: iMessage Archiver

`marchiver` is a tool for extracting iMessage and SMS archives from iTunes backups of your iOS devices and converting them into easily readable HTML pages, as well as JSON files that you can use in your own scripts and applications.

## Installation
`marchiver` requires [Node.js and NPM](https://nodejs.org/) to be installed.

Then, simply install the package globally from NPM:

	npm install -g marchiver

If you get an error, you probably need install with root privileges:

	sudo npm install -g marchiver

## Usage

`marchiver` is operated with a simple terminal command:

	marchiver --input=[backup dir] --output=[output dir]

You can often find your iTunes backups (if you are on OS X) located at `~/Library/Application Support/MobileSync/Backup`.  `marchiver` currently does not support encrypted backups.  Support for this feature is currently not planned, but if you want it or are interested in working on it, please submit an issue or a pull request.