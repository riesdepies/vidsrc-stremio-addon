const fs = require('fs');
const path = require('path');

// Deze functie loopt door alle mappen en bestanden
const getAllFiles = function(dirPath, arrayOfFiles) {
  const files = fs.readdirSync(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function(file) {
    if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
      arrayOfFiles.push(`[DIR] ${file}/`);
      arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
    } else {
      arrayOfFiles.push(file);
    }
  });

  return arrayOfFiles;
};

module.exports = (req, res) => {
  try {
    // De hoofdmap van een Vercel serverless function is /var/task
    const projectRoot = path.resolve('/var/task');
    
    let fileList = 'Bestanden gevonden in de project root (/var/task):\n\n';
    
    const allPaths = getAllFiles(projectRoot);
    fileList += allPaths.join('\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(fileList);
  } catch (error) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(500).send('Fout bij het lezen van de bestandsstructuur:\n\n' + error.stack);
  }
};